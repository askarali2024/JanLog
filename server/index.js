'use strict';

/**
 * JanLog server — Express static hosting + REST + Server-Sent Events hub.
 *
 * Endpoints:
 *   GET  /api/sources          -> list of discovered log sources
 *   GET  /api/sources/tail     -> { source, lines } initial history
 *   GET  /api/events           -> SSE stream (line / sources / stats / hello)
 *   POST /api/paths            -> add a file / directory / glob to watch
 *   GET  /                     -> the single-page UI
 */

const express = require('express');
const path = require('path');
const config = require('./config');
const LogManager = require('./watcher');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const manager = new LogManager(config);
const clients = new Set();

/* ------------------------------------------------------------------ *
 * SSE plumbing
 * ------------------------------------------------------------------ */

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client went away; close handler will clean up */
  }
}

function broadcast(event, data) {
  for (const res of clients) sseSend(res, event, data);
}

manager.on('line', (payload) => broadcast('line', payload));
manager.on('sources', (snap) => broadcast('sources', snap));
manager.on('stats', (snap) => broadcast('stats', snap));

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sseSend(res, 'hello', {
    config: {
      maxBufferLines: config.maxBufferLines,
      initialTailLines: config.initialTailLines,
      allowUiPaths: config.allowUiPaths,
    },
    sources: manager.snapshot().sources,
  });
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(':hb\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

/* ------------------------------------------------------------------ *
 * REST API
 * ------------------------------------------------------------------ */

app.get('/api/sources', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(manager.snapshot());
});

app.get('/api/sources/tail', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = String(req.query.id || '');
  const src = manager.sources.get(id);
  if (!src) return res.status(404).json({ error: 'source not found' });

  // Wait for the initial tail to finish if it is still in flight.
  if (src.initPromise) await src.initPromise.catch(() => {});

  const requested = parseInt(req.query.lines, 10);
  const n = Math.max(
    0,
    Math.min(Number.isFinite(requested) ? requested : config.initialTailLines, config.maxBufferLines)
  );
  res.json({ source: src.toJSON(), lines: src.lines.slice(-n) });
});

app.post('/api/paths', async (req, res) => {
  if (!config.allowUiPaths) {
    return res.status(403).json({ error: 'adding paths from the UI is disabled (ALLOW_UI_PATHS=false)' });
  }
  const input = req.body && typeof req.body.path === 'string' ? req.body.path.trim() : '';
  if (!input) return res.status(400).json({ error: 'missing "path" in request body' });
  if (input.length > 4096) return res.status(400).json({ error: 'path too long' });

  const result = await manager.addPath(input);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true, added: result.added, snapshot: manager.snapshot() });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

/* ------------------------------------------------------------------ *
 * Static UI
 * ------------------------------------------------------------------ */

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function main() {
  await manager.init();

  const server = app.listen(config.port, () => {
    console.log(`[janlog] ▶ streaming at http://localhost:${config.port}`);
    console.log(`[janlog]   sources: ${config.logPathList.join(', ')}`);
    console.log(`[janlog]   buffer : ${config.maxBufferLines} lines/source · tail ${config.initialTailLines} lines`);
  });

  const shutdown = () => {
    console.log('\n[janlog] shutting down…');
    manager.stop();
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[janlog] fatal:', err);
  process.exit(1);
});
