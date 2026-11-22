'use strict';

/**
 * LogManager — discovers log files, watches their directories with
 * `fs.watch`, and on every change reads ONLY the newly appended bytes via
 * a byte-offset `fs.createReadStream`. Handles:
 *   - appends (the normal case)
 *   - truncation in place (size < offset  -> restart from byte 0)
 *   - rotation via rename + recreate (new inode, size < offset -> restart)
 *   - delete (source marked `missing`, resumes if the path reappears)
 *
 * A 2s safety poll re-stats every file so missed inotify/FSEvents events
 * (e.g. on network filesystems) never silently drop data.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { LogSource } = require('./logstore');
const { expandGlob, hasMagic } = require('./glob');

const LOG_EXTENSIONS = new Set([
  '.log', '.txt', '.out', '.err', '.json', '.jsonl', '.ndjson', '.trace',
]);

const POLL_INTERVAL_MS = 2000;
const STATS_INTERVAL_MS = 2500;

class LogManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.sources = new Map(); // abs path -> LogSource
    this.dirWatchers = new Map(); // abs dir -> fs.FSWatcher
    this.pollTimer = null;
    this.statsTimer = null;
    this.stopped = false;
  }

  async init() {
    for (const entry of this.config.logPathList) {
      const result = await this.addPath(entry);
      if (result.error) {
        console.warn(`[janlog] ${result.error}`);
      } else if (result.added && result.added.length) {
        console.log(`[janlog] watching ${result.added.length} file(s) from "${entry}"`);
      }
    }
    if (this.sources.size === 0) {
      console.warn(`[janlog] no log sources found yet — waiting for files to appear...`);
    }
    this.pollTimer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS);
    this.statsTimer = setInterval(() => {
      if (!this.stopped) this.emit('stats', this.snapshot());
    }, STATS_INTERVAL_MS);
    this.pollTimer.unref?.();
    this.statsTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.statsTimer);
    for (const w of this.dirWatchers.values()) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.dirWatchers.clear();
  }

  snapshot() {
    return { sources: [...this.sources.values()].map((s) => s.toJSON()) };
  }

  /**
   * Add a file, directory or glob pattern. Returns
   * { added: [absPath...] } or { error: message }.
   */
  async addPath(input) {
    const raw = String(input || '').trim();
    if (!raw) return { error: 'empty path' };

    if (hasMagic(raw)) {
      const matches = await expandGlob(raw);
      for (const file of matches) this.addFile(file);
      if (!matches.length) return { added: [], error: `no files matched glob: ${raw}` };
      return { added: matches };
    }

    const abs = path.resolve(raw);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return { added: [], error: `path not found: ${raw}` };
    }

    if (st.isDirectory()) {
      const added = await this.addDirectory(abs);
      return { added };
    }
    if (st.isFile()) {
      this.addFile(abs);
      return { added: [abs] };
    }
    return { error: `unsupported path type: ${raw}` };
  }

  /** Recursively watch a directory; returns the files discovered in it. */
  async addDirectory(dir, depth = 0) {
    const added = [];
    if (this.dirWatchers.has(dir) || depth > 8) return added;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return added;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip dotfiles
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        added.push(...(await this.addDirectory(full, depth + 1)));
      } else if (entry.isFile() && LOG_EXTENSIONS.has(path.extname(entry.name))) {
        this.addFile(full);
        added.push(full);
      }
    }

    try {
      const watcher = fs.watch(dir, (event, filename) => this.onDirEvent(dir, event, filename));
      watcher.on('error', (err) => {
        console.warn(`[janlog] watcher error on ${dir}: ${err.message}`);
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, watcher);
    } catch (err) {
      console.warn(`[janlog] cannot watch directory ${dir}: ${err.message}`);
    }
    return added;
  }

  onDirEvent(dir, event, filename) {
    if (!filename) return;
    const full = path.join(dir, filename);
    const existing = this.sources.get(full);
    if (existing) {
      this.checkSource(existing);
      return;
    }
    // Possibly a brand new file or directory — inspect it.
    fs.stat(full, (err, st) => {
      if (err || this.stopped) return;
      if (st.isDirectory()) {
        this.addDirectory(full).catch(() => {});
      } else if (st.isFile() && LOG_EXTENSIONS.has(path.extname(full))) {
        const src = this.addFile(full);
        if (src) {
          console.log(`[janlog] new source discovered: ${full}`);
          this.emit('sources', this.snapshot());
        }
      }
    });
  }

  addFile(absPath) {
    const existing = this.sources.get(absPath);
    if (existing) return existing;
    const src = new LogSource(absPath, this.config.maxBufferLines);
    this.sources.set(absPath, src);
    src
      .initialize(this.config.initialTailLines)
      .then(() => {
        if (!this.stopped) this.emit('sources', this.snapshot());
      })
      .catch((err) => console.warn(`[janlog] failed to tail ${absPath}: ${err.message}`));
    return src;
  }

  pollAll() {
    for (const src of this.sources.values()) this.checkSource(src);
  }

  /** Compare current file size against our byte offset and read the delta. */
  checkSource(src) {
    if (src.reading) return;
    fs.stat(src.path, (err, st) => {
      if (err) {
        if (!src.missing) {
          src.missing = true;
          this.emit('sources', this.snapshot());
        }
        return;
      }
      const wasMissing = src.missing;
      src.missing = false;
      if (wasMissing) this.emit('sources', this.snapshot());

      src.size = st.size;
      if (st.size === src.offset) return;
      if (st.size < src.offset) {
        // Truncated in place, or rotated to a fresh file at the same path.
        // Restart from byte 0 and re-read.
        src.offset = 0;
        src.partial = '';
      }
      this.readNewBytes(src, st.size);
    });
  }

  /** Read [offset, size) — only the newly appended bytes. */
  readNewBytes(src, size) {
    src.reading = true;
    const stream = fs.createReadStream(src.path, { start: src.offset, end: size - 1 });
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (err) => {
      src.reading = false;
      console.warn(`[janlog] read error on ${src.path}: ${err.message}`);
    });
    stream.on('end', () => {
      src.reading = false;
      src.offset = size;
      src.size = size;
      this.processChunk(src, Buffer.concat(chunks));
    });
  }

  /** Split the chunk on newlines, carrying a partial trailing line forward. */
  processChunk(src, data) {
    const text = src.partial + data.toString('utf8');
    const parts = text.split('\n');
    src.partial = parts.pop(); // keep the incomplete tail for next time
    for (const raw of parts) {
      const line = src.appendLine(raw);
      if (line) this.emit('line', { sourceId: src.id, line });
    }
  }
}

module.exports = LogManager;
