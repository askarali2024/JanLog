'use strict';

/**
 * LogStore — per-source state: byte offset, partial line carry, ring buffer
 * of parsed lines and per-level counters. Only newly appended bytes are ever
 * read after initialization, so multi-GB files never land in memory.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/* ------------------------------------------------------------------ *
 * Level detection
 * ------------------------------------------------------------------ */

function pickScalar(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && typeof v !== 'object') return v;
  }
  return null;
}

/**
 * Normalize a level value coming from structured JSON logs.
 * Handles named levels (pino/winston/log4j strings), numeric pino levels
 * (10-60) and syslog severities (0-7).
 */
function normalizeLevelName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (value >= 50) return 'error';
    if (value >= 40) return 'warn';
    if (value >= 30) return 'info';
    if (value >= 10) return 'debug';
    if (value >= 0 && value <= 7) {
      // syslog severity
      if (value <= 3) return 'error';
      if (value === 4) return 'warn';
      if (value <= 6) return 'info';
      return 'debug';
    }
    return null;
  }
  const s = String(value).trim().toLowerCase();
  if (['fatal', 'emerg', 'emergency', 'alert', 'crit', 'critical', 'error', 'err', 'panic'].includes(s)) return 'error';
  if (['warn', 'warning'].includes(s)) return 'warn';
  if (['info', 'notice', 'log'].includes(s)) return 'info';
  if (['debug', 'trace', 'verbose', 'dbg', 'silly', 'fine', 'finest'].includes(s)) return 'debug';
  return null;
}

function levelFromText(raw) {
  // Level-word scan for plain-text logs (covers "[ERROR]", "level=error",
  // "ERR 2026-…", logfmt, etc.)
  if (/\b(?:fatal|emerg(?:ency)?|alert|crit(?:ical)?)\b/i.test(raw)) return 'error';
  if (/\berr(?:or)?\b/i.test(raw)) return 'error';
  if (/\bwarn(?:ing)?s?\b/i.test(raw)) return 'warn';
  if (/\b(?:info|notice)\b/i.test(raw)) return 'info';
  if (/\b(?:debug|trace|verbose|dbg)\b/i.test(raw)) return 'debug';
  return null;
}

/**
 * Build one line record. Detects structured JSON (Pino / Winston / Docker
 * JSON logs), extracts level, message and timestamp fields.
 */
function makeLine(seq, raw) {
  let json = null;
  let level = null;
  let message = null;
  let tsField = null;

  const t = raw.trim();
  if (t.length > 1 && t.startsWith('{') && t.endsWith('}')) {
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        json = obj;
        level = normalizeLevelName(pickScalar(obj, ['level', 'severity', 'lvl', 'priority']));
        message = pickScalar(obj, ['msg', 'message', 'error', 'err', 'description', 'event', 'log']);
        tsField = pickScalar(obj, ['time', 'timestamp', 'ts', '@t', 'date', 'datetime', 'time_ms']);
      }
    } catch {
      /* not JSON — fall through to plain text */
    }
  }

  if (!level) level = levelFromText(raw);

  return {
    seq,
    ts: Date.now(),
    raw,
    level: level || 'plain',
    json,
    message: message === null ? null : String(message),
    tsField,
  };
}

/* ------------------------------------------------------------------ *
 * Efficient backwards tail
 * ------------------------------------------------------------------ */

/**
 * Read the last `maxLines` lines of a file without loading it into memory.
 * Returns { lines, endsWithNewline, size }.
 */
async function tailFile(filePath, maxLines) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0 || maxLines <= 0) {
      return { lines: [], endsWithNewline: true, size };
    }

    const CHUNK = 64 * 1024;
    let pos = size;
    let pending = ''; // leftmost text, possibly an incomplete line
    const out = []; // collected lines, newest first

    while (pos > 0 && out.length < maxLines + 1) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, pos);
      const text = buf.toString('utf8') + pending;
      const parts = text.split('\n');
      pending = parts.shift();
      for (let i = parts.length - 1; i >= 0; i--) out.push(parts[i]);
    }
    if (pos === 0 && pending !== '') out.push(pending);

    const lines = out.slice(0, maxLines).reverse();

    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, 1, size - 1);
    const endsWithNewline = lastByte[0] === 0x0a;

    return { lines, endsWithNewline, size };
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ *
 * LogSource
 * ------------------------------------------------------------------ */

class LogSource {
  constructor(filePath, maxLines) {
    this.id = filePath; // absolute path used as stable identifier
    this.path = filePath;
    this.name = path.basename(filePath);
    this.maxLines = maxLines;

    this.lines = []; // ring buffer of line records
    this.seq = 0; // line numbers, monotonic per source
    this.offset = 0; // bytes consumed so far
    this.partial = ''; // trailing bytes after the last newline
    this.size = 0;
    this.missing = false; // file deleted / rotated away
    this.reading = false;
    this.initialized = false;
    this.counts = { total: 0, error: 0, warn: 0, info: 0, debug: 0, plain: 0 };

    this.initPromise = null;
  }

  async initialize(initialTailLines) {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { lines, endsWithNewline, size } = await tailFile(this.path, initialTailLines);
      this.size = size;
      this.offset = size;
      // If the file does not end with a newline the final line is still being
      // written — hold it back as `partial` so the first appended newline
      // completes it instead of duplicating it.
      if (!endsWithNewline && lines.length) this.partial = lines.pop() || '';
      for (const raw of lines) this.appendLine(raw);
      this.initialized = true;
    })();
    return this.initPromise;
  }

  /** Append one raw text line to the ring buffer. Returns the record or null. */
  appendLine(raw) {
    const text = String(raw).replace(/\r$/, '');
    if (!text.trim()) return null;
    this.seq += 1;
    const line = makeLine(this.seq, text);
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
    this.counts.total += 1;
    this.counts[line.level] = (this.counts[line.level] || 0) + 1;
    return line;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      size: this.size,
      missing: this.missing,
      counts: { ...this.counts },
      initialized: this.initialized,
    };
  }
}

module.exports = { LogSource, makeLine, tailFile, normalizeLevelName, levelFromText };
