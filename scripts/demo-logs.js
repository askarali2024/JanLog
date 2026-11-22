#!/usr/bin/env node
'use strict';

/**
 * JanLog demo log generator — writes realistic mixed plain-text and JSON
 * (pino-style) INFO/WARN/ERROR lines so anyone cloning the repo can see the
 * live stream immediately.
 *
 *   npm run demo-logs
 *
 * Optionally point it at another directory:
 *   JANLOG_DEMO_DIR=/tmp/my-logs npm run demo-logs
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.JANLOG_DEMO_DIR || path.join(__dirname, '..', 'logs');
const APP_LOG = path.join(LOG_DIR, 'app.log'); // plain-text log
const JSON_LOG = path.join(LOG_DIR, 'api.json'); // structured JSON log
const SEED_LINES = parseInt(process.env.SEED_LINES || '160', 10);

const services = ['auth', 'api', 'db', 'worker', 'billing', 'gateway', 'scheduler'];
const users = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
const ips = ['10.0.4.12', '10.0.4.31', '172.16.8.5', '192.168.1.44', '10.1.2.7'];
const routes = [
  '/api/users', '/api/orders', '/api/items/42', '/api/search?q=logs',
  '/api/auth/login', '/health', '/api/metrics',
];
const errorTexts = [
  'ECONNREFUSED 127.0.0.1:5432',
  'ETIMEDOUT after 30000ms',
  "Cannot read property 'id' of undefined",
  'Out of memory: heap 512MB exceeded',
  'Rate limit exceeded for tenant t_88231',
  'EACCES: permission denied /var/data/cache.json',
];
const errorCodes = ['EDB', 'ENET', 'EQUERY', 'EAPP'];
const warnTexts = [
  'Slow query detected',
  'Retry attempt 3/5 failed',
  'Cache miss ratio above threshold (0.82)',
  'Connection pool at 90% capacity',
  'TLS certificate expires in 6 days',
];

const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const stamp = (d = new Date()) => d.toISOString();
const reqId = () => Math.random().toString(16).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickLevel() {
  const r = Math.random();
  if (r < 0.68) return 'INFO';
  if (r < 0.84) return 'DEBUG';
  if (r < 0.95) return 'WARN';
  return 'ERROR';
}

/** A plain-text log entry (possibly multi-line when it carries a stack trace). */
function plainLine(when) {
  const lvl = pickLevel();
  const svc = rnd(services);
  const ts = stamp(when);
  const rid = reqId();

  if (lvl === 'ERROR') {
    const lines = [`${ts} ERROR [${svc}] ${rnd(errorTexts)} reqId=${rid}`];
    const depth = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < depth; i++) {
      lines.push(`    at frame${i} (${svc}/handler${i}.js:${100 + i * 37}:${12 + i})`);
    }
    return lines.join('\n');
  }
  if (lvl === 'WARN') {
    return `${ts} WARN  [${svc}] ${rnd(warnTexts)} reqId=${rid}`;
  }
  if (lvl === 'DEBUG') {
    return `${ts} DEBUG [${svc}] cache lookup key=user:${rnd(users)} hit=${Math.random() > 0.5} reqId=${rid}`;
  }
  const route = rnd(routes);
  const method = route === '/api/auth/login' ? 'POST' : Math.random() < 0.5 ? 'GET' : 'POST';
  const status = rnd([200, 200, 201, 204, 200, 304]);
  const ms = 2 + Math.floor(Math.random() * 250);
  return `${ts} INFO  [${svc}] ${method} ${route} ${status} ${ms}ms ip=${rnd(ips)} user=${rnd(users)} reqId=${rid}`;
}

/** A pino-style structured JSON entry. */
function jsonLine(when) {
  const svc = rnd(services);
  const rid = reqId();
  const base = { level: 30, time: when.getTime(), svc, rid };
  const r = Math.random();

  if (r < 0.62) {
    const route = rnd(routes);
    return JSON.stringify({
      ...base,
      level: 30,
      msg: `${route === '/api/auth/login' ? 'POST' : 'GET'} ${route} 200`,
      status: 200,
      durationMs: 3 + Math.floor(Math.random() * 300),
      user: rnd(users),
    });
  }
  if (r < 0.75) {
    return JSON.stringify({
      ...base,
      level: 20,
      msg: 'cache lookup',
      key: `user:${rnd(users)}`,
      hit: Math.random() > 0.5,
    });
  }
  if (r < 0.92) {
    return JSON.stringify({
      ...base,
      level: 40,
      msg: rnd(warnTexts),
      attempt: 1 + Math.floor(Math.random() * 4),
      maxAttempts: 5,
    });
  }
  const stack = [
    `Error: ${rnd(errorTexts)}`,
    `    at handleRequest (${svc}/routes.js:${Math.floor(Math.random() * 400) + 10}:17)`,
    '    at Layer.handle (middleware.js:88:5)',
    '    at next (router.js:31:9)',
  ].join('\n');
  return JSON.stringify({
    ...base,
    level: 50,
    msg: 'request failed',
    err: { message: rnd(errorTexts), code: rnd(errorCodes), stack },
    status: 500,
  });
}

function seed() {
  const plain = [];
  const json = [];
  for (let i = SEED_LINES; i > 0; i--) {
    const when = new Date(Date.now() - i * 1500);
    plain.push(plainLine(when));
    json.push(jsonLine(when));
  }
  fs.appendFileSync(APP_LOG, plain.join('\n') + '\n');
  fs.appendFileSync(JSON_LOG, json.join('\n') + '\n');
  console.log(`Seeded ${SEED_LINES} lines into each file.`);
}

async function stream() {
  console.log('Streaming demo logs to:');
  console.log(`  ${APP_LOG}`);
  console.log(`  ${JSON_LOG}`);
  console.log('Press Ctrl+C to stop.\n');
  let n = 0;
  for (;;) {
    await sleep(250 + Math.random() * 500);
    const file = Math.random() < 0.5 ? APP_LOG : JSON_LOG;
    const line = file === APP_LOG ? plainLine(new Date()) : jsonLine(new Date());
    fs.appendFileSync(file, line + '\n');
    n++;
    if (n % 50 === 0) process.stdout.write(`  ${n} entries written\r`);
  }
}

process.on('SIGINT', () => {
  console.log('\nDemo log generator stopped.');
  process.exit(0);
});

fs.mkdirSync(LOG_DIR, { recursive: true });
// Start from a clean slate so restarts stay predictable.
fs.writeFileSync(APP_LOG, '');
fs.writeFileSync(JSON_LOG, '');

seed();
stream().catch((err) => {
  console.error('demo-logs failed:', err);
  process.exit(1);
});
