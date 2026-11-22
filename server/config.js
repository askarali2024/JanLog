'use strict';

/**
 * JanLog configuration — all knobs come from environment variables.
 */

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

const rawPaths = String(process.env.LOG_PATHS || './logs')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

module.exports = {
  /** HTTP port to listen on. */
  port: toInt(process.env.PORT, 8002),

  /** Comma-separated files, directories or globs to watch. */
  logPathList: rawPaths.length ? rawPaths : ['./logs'],

  /** Lines tailed from each file when it is first discovered. */
  initialTailLines: toInt(process.env.INITIAL_TAIL_LINES, 200),

  /** Ring-buffer size (lines) kept per source, in the server and the browser. */
  maxBufferLines: Math.max(100, toInt(process.env.MAX_BUFFER_LINES, 2000)),

  /** Allow adding new watch paths from the web UI. */
  allowUiPaths: toBool(process.env.ALLOW_UI_PATHS, true),
};
