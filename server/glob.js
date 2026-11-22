'use strict';

/**
 * Minimal glob support so JanLog stays dependency-free beyond Express.
 * Supported syntax: `*` (within one segment), `**` (any depth), `?`,
 * `[abc]` / `[!abc]` character classes and `{a,b}` alternation.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAGIC = ['*', '?', '{', '['];

function hasMagic(pattern) {
  return MAGIC.some((c) => pattern.includes(c));
}

function escapeLiteral(c) {
  return c.replace(/[.+^$(){}|[\]\\]/g, '\\$&');
}

function globSource(p) {
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        while (p[i + 1] === '*') i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const alts = p
          .slice(i + 1, end)
          .split(',')
          .map((a) => globSource(a))
          .join('|');
        re += '(?:' + alts + ')';
        i = end;
      }
    } else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        let cls = p.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = end;
      }
    } else {
      re += escapeLiteral(c);
    }
    i++;
  }
  return re;
}

function globToRegExp(pattern) {
  return new RegExp('^' + globSource(pattern) + '$');
}

/**
 * Expand a glob pattern into a list of existing absolute file paths.
 * Walks from the deepest static directory prefix of the pattern.
 */
async function expandGlob(pattern) {
  const abs = path.resolve(pattern);
  const re = globToRegExp(abs);

  let idx = 0;
  while (idx < abs.length && !MAGIC.includes(abs[idx])) idx++;
  let base = abs.slice(0, idx);
  const lastSlash = base.lastIndexOf(path.sep);
  base = lastSlash > 0 ? base.slice(0, lastSlash) : path.sep;

  const results = [];

  let st;
  try {
    st = await fsp.stat(base);
  } catch {
    return results;
  }
  if (st.isFile()) {
    if (re.test(base)) results.push(base);
    return results;
  }

  const walk = async (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && re.test(full)) {
        results.push(full);
      }
    }
  };

  await walk(base, 0);
  return results;
}

module.exports = { hasMagic, globToRegExp, expandGlob };
