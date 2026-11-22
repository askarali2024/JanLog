/* ============================================================
   JanLog — front-end app
   SSE consumer with bounded DOM rendering (MAX_BUFFER_LINES cap).
   ============================================================ */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    connBadge: $('conn-badge'),
    connLabel: $('conn-label'),
    sourceBtn: $('source-btn'),
    sourceName: $('source-name'),
    sourceSize: $('source-size'),
    sourceUnread: $('source-unread'),
    sourceMenu: $('source-menu'),
    sourceList: $('source-list'),
    addPathForm: $('add-path-form'),
    addPathInput: $('add-path-input'),
    streamBtn: $('stream-btn'),
    streamLabel: $('stream-label'),
    clearBtn: $('clear-btn'),
    filterInput: $('filter-input'),
    regexBtn: $('regex-btn'),
    caseBtn: $('case-btn'),
    levelPills: $('level-pills'),
    errorsBtn: $('errors-btn'),
    errorsCount: $('errors-count'),
    wrapBtn: $('wrap-btn'),
    scrollBtn: $('scroll-btn'),
    downloadBtn: $('download-btn'),
    viewer: $('viewer'),
    lines: $('lines'),
    emptyState: $('empty-state'),
    jumpLatest: $('jump-latest'),
    errorDrawer: $('error-drawer'),
    errorCount: $('error-count'),
    errorClose: $('error-close'),
    errorList: $('error-list'),
    toast: $('toast'),
  };

  const state = {
    sources: new Map(), // id -> source meta (+ client-side _unreadErrors)
    activeId: null,
    lines: [], // bounded buffer of line records for the active source
    paused: false,
    connected: false,
    level: 'all',
    filterText: '',
    regexMode: false,
    caseSensitive: false,
    autoScroll: true,
    drawerOpen: false,
  };

  let maxBuffer = 2000;
  let allowUiPaths = true;
  let matcher = null;
  const lineBySeq = new Map();
  let pendingLines = [];
  let updateQueued = false;
  let filterTimer = null;
  let toastTimer = null;

  /* ---------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------- */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function fmtClock(ts) {
    return new Date(ts).toTimeString().slice(0, 8);
  }

  function fmtTsField(v) {
    if (v == null) return '';
    if (typeof v === 'number') {
      const ms = v > 1e14 ? v / 1e6 : v > 1e11 ? v / 1e3 : v; // ns / µs / ms
      const d = new Date(ms);
      return isNaN(d) ? String(v) : d.toISOString().slice(11, 23);
    }
    const s = String(v);
    const d = new Date(s);
    if (!isNaN(d) && s.length > 12) return d.toISOString().slice(11, 23);
    return s.slice(0, 23);
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  function copyText(text, what) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast(`${what} copied to clipboard`),
        () => toast('Copy failed')
      );
    } else {
      toast('Clipboard unavailable');
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------- *
   * Filtering
   * ---------------------------------------------------------- */

  function compileMatcher() {
    matcher = null;
    els.filterInput.classList.remove('invalid');
    const q = state.filterText;
    if (!q) return;

    const slashForm = q.length > 2 && q.startsWith('/') && q.endsWith('/');
    const isRegex = state.regexMode || slashForm;
    const body = slashForm ? q.slice(1, -1) : q;

    if (isRegex) {
      try {
        matcher = { re: new RegExp(body, state.caseSensitive ? '' : 'i') };
      } catch {
        // Invalid regex — flag it and fall back to a literal search.
        els.filterInput.classList.add('invalid');
        matcher = { text: body, ci: !state.caseSensitive };
      }
    } else {
      matcher = { text: body, ci: !state.caseSensitive };
    }
  }

  function matchesRaw(raw) {
    if (!matcher) return true;
    if (matcher.re) return matcher.re.test(raw);
    return matcher.ci
      ? raw.toLowerCase().includes(matcher.text.toLowerCase())
      : raw.includes(matcher.text);
  }

  function levelPasses(line) {
    return state.level === 'all' || state.level === line.level;
  }

  function passesFilter(line) {
    return levelPasses(line) && matchesRaw(line.raw);
  }

  /** Find match ranges in a string, for <mark> highlighting. */
  function findRanges(text) {
    const ranges = [];
    if (!matcher) return ranges;
    if (matcher.re) {
      const flags = matcher.re.flags.includes('g') ? matcher.re.flags : matcher.re.flags + 'g';
      const re = new RegExp(matcher.re.source, flags);
      let m;
      let guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 400) {
        if (m[0].length) ranges.push([m.index, m.index + m[0].length]);
        else re.lastIndex++;
      }
    } else {
      const hay = matcher.ci ? text.toLowerCase() : text;
      const needle = matcher.ci ? matcher.text.toLowerCase() : matcher.text;
      if (!needle) return ranges;
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) {
        ranges.push([i, i + needle.length]);
        i += needle.length;
      }
    }
    return ranges;
  }

  /** Wrap filter matches in <mark> inside a live DOM subtree (textContent-safe). */
  function applyHighlights(container) {
    if (!matcher) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      if (!text) continue;
      const ranges = findRanges(text);
      if (!ranges.length) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const [s, e] of ranges) {
        if (s > last) frag.appendChild(document.createTextNode(text.slice(last, s)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(s, e);
        frag.appendChild(mark);
        last = e;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* ---------------------------------------------------------- *
   * Rendering (bounded at maxBuffer rows)
   * ---------------------------------------------------------- */

  function buildRow(line) {
    const row = el('div', 'line-row lvl-' + line.level + (line.json ? ' json-line' : ''));
    row.dataset.seq = line.seq;

    const ln = el('span', 'ln');
    ln.textContent = line.seq;

    const txt = el('span', 'txt');
    if (line.json) {
      // Compact one-line summary for structured logs.
      const ts = el('span', 'j-ts');
      ts.textContent = fmtTsField(line.tsField) || fmtClock(line.ts);
      const lvl = el('span', 'lvl-badge lvl-' + line.level);
      lvl.textContent = line.level.toUpperCase();
      const msg = el('span', 'j-msg');
      msg.textContent = line.message != null ? line.message : line.raw;
      txt.append(ts, lvl, msg);
    } else {
      txt.textContent = line.raw;
    }
    applyHighlights(txt);
    row.append(ln, txt);
    return row;
  }

  /** Simple JSON syntax highlighter over an already-escaped string. */
  function highlightJsonString(pretty) {
    return pretty.replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
      (match, str, colon, bool) => {
        if (str !== undefined) {
          return colon !== undefined
            ? `<span class="j-key">${str}</span><span class="j-punc">${colon}</span>`
            : `<span class="j-str">${str}</span>`;
        }
        if (bool !== undefined) return `<span class="j-bool">${match}</span>`;
        if (match === 'null') return `<span class="j-null">null</span>`;
        return `<span class="j-num">${match}</span>`;
      }
    );
  }

  function buildJsonExpand(line) {
    const box = el('div', 'json-expand');

    const tools = el('div', 'json-tools');
    tools.appendChild(el('span', 'json-label', 'Structured JSON'));

    const copyJson = el('button', 'copy-btn', 'Copy JSON');
    copyJson.type = 'button';
    copyJson.addEventListener('click', () =>
      copyText(JSON.stringify(line.json, null, 2), 'JSON')
    );

    const copyLine = el('button', 'copy-btn', 'Copy Line');
    copyLine.type = 'button';
    copyLine.addEventListener('click', () => copyText(line.raw, 'Line'));

    tools.append(copyJson, copyLine);

    const pre = el('pre', 'json-pretty');
    pre.innerHTML = highlightJsonString(escapeHtml(JSON.stringify(line.json, null, 2)));

    box.append(tools, pre);
    return box;
  }

  function updateEmptyState() {
    els.emptyState.hidden = els.lines.childElementCount > 0;
  }

  function trimDom() {
    while (els.lines.childElementCount > maxBuffer) {
      els.lines.removeChild(els.lines.firstChild);
    }
  }

  function scrollToBottom() {
    els.viewer.scrollTop = els.viewer.scrollHeight;
  }

  function renderAll() {
    els.lines.textContent = '';
    const start = Math.max(0, state.lines.length - maxBuffer);
    const frag = document.createDocumentFragment();
    for (let i = start; i < state.lines.length; i++) {
      const line = state.lines[i];
      if (passesFilter(line)) frag.appendChild(buildRow(line));
    }
    els.lines.appendChild(frag);
    updateCounts();
    updateEmptyState();
    if (state.autoScroll && !state.paused) scrollToBottom();
  }

  function flushAppends() {
    if (!pendingLines.length) return;
    const frag = document.createDocumentFragment();
    for (const line of pendingLines) {
      if (passesFilter(line)) frag.appendChild(buildRow(line));
    }
    pendingLines = [];
    els.lines.appendChild(frag);
    trimDom();
    updateEmptyState();
    if (state.autoScroll) scrollToBottom();
  }

  function scheduleUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(() => {
      updateQueued = false;
      updateCounts();
      if (!state.paused) flushAppends();
    });
  }

  function pushLine(line) {
    state.lines.push(line);
    lineBySeq.set(line.seq, line);
    if (state.lines.length > maxBuffer) {
      const removed = state.lines.splice(0, state.lines.length - maxBuffer);
      for (const l of removed) lineBySeq.delete(l.seq);
    }
    if (pendingLines.length > maxBuffer) {
      pendingLines.splice(0, pendingLines.length - maxBuffer);
    }
    if (!state.paused) pendingLines.push(line);
    scheduleUpdate();
  }

  /* ---------------------------------------------------------- *
   * Counts, pills, badges
   * ---------------------------------------------------------- */

  function updateCounts() {
    const counts = { all: 0, error: 0, warn: 0, info: 0, debug: 0 };
    for (const line of state.lines) {
      counts.all++;
      if (counts[line.level] !== undefined) counts[line.level]++;
    }
    for (const pill of els.levelPills.querySelectorAll('.pill')) {
      pill.querySelector('.count').textContent = counts[pill.dataset.level] || 0;
    }
    els.errorsCount.textContent = counts.error;

    const src = state.sources.get(state.activeId);
    const unread = src ? src._unreadErrors || 0 : 0;
    els.sourceUnread.hidden = !unread;
    els.sourceUnread.textContent = unread;

    if (state.drawerOpen) renderErrorDrawer();
    updateSourceButton();
  }

  function updateSourceButton() {
    const src = state.sources.get(state.activeId);
    els.sourceName.textContent = src ? src.name : 'No source';
    els.sourceSize.textContent = src ? fmtBytes(src.size) : '';
    document.title = src ? `${src.name} — JanLog` : 'JanLog — Real-time Log Stream';
  }

  function updateStreamUi() {
    els.streamBtn.classList.toggle('paused', state.paused);
    els.streamLabel.textContent = state.paused ? 'Stream' : 'Pause';
    els.connBadge.className = 'conn-badge ' + (state.paused ? 'paused' : state.connected ? 'streaming' : 'disconnected');
    els.connLabel.textContent = state.paused ? 'Paused' : state.connected ? 'Streaming' : 'Disconnected';
  }

  /* ---------------------------------------------------------- *
   * Source menu & switching
   * ---------------------------------------------------------- */

  function toggleMenu(force) {
    const open = force !== undefined ? force : els.sourceMenu.hidden;
    els.sourceMenu.hidden = !open;
    els.sourceBtn.classList.toggle('open', open);
    if (open) renderSourceMenu();
  }

  function renderSourceMenu() {
    els.sourceList.textContent = '';
    if (!state.sources.size) {
      const empty = el('div', 'err-empty', 'No sources yet.');
      els.sourceList.appendChild(empty);
      return;
    }
    for (const src of state.sources.values()) {
      const item = el('button', 'source-item' + (src.id === state.activeId ? ' active' : ''));
      item.type = 'button';

      const wrap = el('span', 'si-wrap');
      const name = el('span', 'si-name');
      name.textContent = src.name;
      if (src.missing) name.appendChild(el('span', 'missing', ' (missing)'));
      const meta = el('span', 'si-meta');
      meta.textContent = `${fmtBytes(src.size)} · ${src.path}`;
      wrap.append(name, meta);

      item.appendChild(wrap);

      if (src._unreadErrors) {
        const badge = el('span', 'unread-badge');
        badge.textContent = src._unreadErrors;
        item.appendChild(badge);
      }

      item.addEventListener('click', () => {
        toggleMenu(false);
        switchSource(src.id);
      });
      els.sourceList.appendChild(item);
    }
  }

  async function switchSource(id) {
    state.activeId = id;
    const src = state.sources.get(id);
    if (src) src._unreadErrors = 0;
    state.lines = [];
    pendingLines = [];
    lineBySeq.clear();
    updateSourceButton();
    renderAll();

    try {
      const res = await fetch(`/api/sources/tail?id=${encodeURIComponent(id)}&lines=${maxBuffer}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (state.activeId !== id) return; // user switched again meanwhile
      state.lines = Array.isArray(data.lines) ? data.lines : [];
      lineBySeq.clear();
      for (const l of state.lines) lineBySeq.set(l.seq, l);
      if (src) {
        src.size = data.source ? data.source.size : src.size;
      }
      renderAll();
    } catch {
      toast('Failed to load log history');
    }
    setAutoScroll(true);
  }

  function applySources(snap) {
    const prev = state.sources;
    const next = new Map();
    for (const s of snap.sources || []) {
      const old = prev.get(s.id);
      next.set(s.id, old ? Object.assign(old, s) : Object.assign({ _unreadErrors: 0 }, s));
    }
    state.sources = next;
    if (els.sourceMenu.hidden === false) renderSourceMenu();

    if (!state.activeId && next.size) {
      switchSource(next.keys().next().value);
    } else if (state.activeId && !next.has(state.activeId)) {
      state.activeId = null;
      state.lines = [];
      pendingLines = [];
      lineBySeq.clear();
      renderAll();
    } else {
      updateSourceButton();
      updateCounts();
    }
  }

  function applyStats(snap) {
    let changed = false;
    for (const s of snap.sources || []) {
      const existing = state.sources.get(s.id);
      if (existing) {
        if (existing.size !== s.size || existing.missing !== s.missing) changed = true;
        Object.assign(existing, s);
      }
    }
    if (changed) {
      updateSourceButton();
      if (!els.sourceMenu.hidden) renderSourceMenu();
    } else {
      updateSourceButton();
    }
  }

  /* ---------------------------------------------------------- *
   * Error drawer
   * ---------------------------------------------------------- */

  function toggleErrorDrawer(force) {
    const open = force !== undefined ? force : !state.drawerOpen;
    state.drawerOpen = open;
    els.errorDrawer.hidden = !open;
    if (open) renderErrorDrawer();
  }

  function renderErrorDrawer() {
    const errors = state.lines.filter((l) => l.level === 'error').slice(-100).reverse();
    els.errorCount.textContent = errors.length;
    els.errorList.textContent = '';
    if (!errors.length) {
      els.errorList.appendChild(el('div', 'err-empty', 'No errors in the current buffer 🎉'));
      return;
    }
    for (const line of errors) {
      const item = el('button', 'err-item');
      item.type = 'button';
      const meta = el('div', 'err-meta');
      meta.textContent = `#${line.seq} · ${fmtClock(line.ts)}`;
      const msg = el('div', 'err-msg');
      msg.textContent = line.message || line.raw;
      item.append(meta, msg);
      item.addEventListener('click', () => jumpToSeq(line.seq));
      els.errorList.appendChild(item);
    }
  }

  function jumpToSeq(seq) {
    let row = els.lines.querySelector(`.line-row[data-seq="${seq}"]`);
    if (!row) {
      // The line is hidden behind the current filters — relax them.
      state.level = 'all';
      state.filterText = '';
      els.filterInput.value = '';
      compileMatcher();
      updatePillActive();
      renderAll();
      row = els.lines.querySelector(`.line-row[data-seq="${seq}"]`);
    }
    if (!row) {
      toast('Line is no longer in the buffer');
      return;
    }
    setAutoScroll(false);
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation
    row.classList.add('flash');
  }

  /* ---------------------------------------------------------- *
   * SSE connection
   * ---------------------------------------------------------- */

  function connect() {
    const es = new EventSource('/api/events');

    es.onopen = () => {
      state.connected = true;
      updateStreamUi();
    };
    es.onerror = () => {
      state.connected = false;
      updateStreamUi();
    };

    es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      maxBuffer = (d.config && d.config.maxBufferLines) || 2000;
      allowUiPaths = !!(d.config && d.config.allowUiPaths);
      els.addPathForm.hidden = !allowUiPaths;
      applySources({ sources: d.sources });
      updateStreamUi();
    });

    es.addEventListener('line', (e) => {
      const { sourceId, line } = JSON.parse(e.data);
      const src = state.sources.get(sourceId);
      if (line.level === 'error' && (sourceId !== state.activeId || state.paused)) {
        if (src) src._unreadErrors = (src._unreadErrors || 0) + 1;
        updateCounts();
      }
      if (sourceId !== state.activeId) return;
      pushLine(line);
    });

    es.addEventListener('sources', (e) => applySources(JSON.parse(e.data)));
    es.addEventListener('stats', (e) => applyStats(JSON.parse(e.data)));
  }

  /* ---------------------------------------------------------- *
   * UI wiring
   * ---------------------------------------------------------- */

  function setAutoScroll(v) {
    state.autoScroll = v;
    els.scrollBtn.classList.toggle('active', v);
    els.jumpLatest.hidden = true;
  }

  function updatePillActive() {
    for (const pill of els.levelPills.querySelectorAll('.pill')) {
      pill.classList.toggle('active', pill.dataset.level === state.level);
    }
  }

  function init() {
    // Connection + sources
    connect();

    // Source switcher
    els.sourceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    els.sourceUnread.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleErrorDrawer(true);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.source-switch')) toggleMenu(false);
    });

    // Add path form
    els.addPathForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = els.addPathInput.value.trim();
      if (!value) return;
      try {
        const res = await fetch('/api/paths', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: value }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast(data.error || 'Failed to add path');
          return;
        }
        toast(`Added ${data.added.length} source(s)`);
        els.addPathInput.value = '';
        applySources(data.snapshot || { sources: [] });
        if (!state.activeId && data.added.length) switchSource(data.added[0]);
      } catch {
        toast('Failed to add path');
      }
    });

    // Stream / pause
    els.streamBtn.addEventListener('click', () => {
      state.paused = !state.paused;
      const src = state.sources.get(state.activeId);
      if (!state.paused) {
        if (src) src._unreadErrors = 0;
        renderAll();
        scrollToBottom();
      }
      updateStreamUi();
      updateCounts();
    });

    // Clear view
    els.clearBtn.addEventListener('click', () => {
      state.lines = [];
      pendingLines = [];
      lineBySeq.clear();
      renderAll();
      toast('View cleared');
    });

    // Filter input (debounced)
    els.filterInput.addEventListener('input', () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        state.filterText = els.filterInput.value;
        compileMatcher();
        renderAll();
      }, 140);
    });
    els.regexBtn.addEventListener('click', () => {
      state.regexMode = !state.regexMode;
      els.regexBtn.classList.toggle('active', state.regexMode);
      compileMatcher();
      renderAll();
    });
    els.caseBtn.addEventListener('click', () => {
      state.caseSensitive = !state.caseSensitive;
      els.caseBtn.classList.toggle('active', state.caseSensitive);
      compileMatcher();
      renderAll();
    });

    // Level pills
    els.levelPills.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      const level = pill.dataset.level;
      state.level = level === 'all' || state.level === level ? 'all' : level;
      updatePillActive();
      renderAll();
    });

    // Display toggles
    els.wrapBtn.addEventListener('click', () => {
      state.wrap = !state.wrap;
      els.wrapBtn.classList.toggle('active', state.wrap);
      document.body.classList.toggle('wrap', state.wrap);
    });
    els.scrollBtn.addEventListener('click', () => {
      setAutoScroll(!state.autoScroll);
      if (state.autoScroll) scrollToBottom();
    });
    els.downloadBtn.addEventListener('click', () => {
      const src = state.sources.get(state.activeId);
      const text = state.lines
        .filter(passesFilter)
        .map((l) => l.raw)
        .join('\n');
      const blob = new Blob([text + (text ? '\n' : '')], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `janlog-${src ? src.name : 'snapshot'}-${stamp}.log`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Snapshot downloaded');
    });

    // Error drawer
    els.errorsBtn.addEventListener('click', () => toggleErrorDrawer());
    els.errorClose.addEventListener('click', () => toggleErrorDrawer(false));

    // Viewer: auto-scroll unlock + jump pill
    els.viewer.addEventListener('scroll', () => {
      const distance = els.viewer.scrollHeight - els.viewer.scrollTop - els.viewer.clientHeight;
      if (distance > 60) {
        if (state.autoScroll) setAutoScroll(false);
        els.jumpLatest.hidden = false;
      } else {
        els.jumpLatest.hidden = true;
      }
    });
    els.jumpLatest.addEventListener('click', () => {
      setAutoScroll(true);
      scrollToBottom();
    });

    // Row interactions: JSON expand + copy (event delegation)
    els.lines.addEventListener('click', (e) => {
      const row = e.target.closest('.line-row');
      if (!row || e.target.closest('.json-expand')) return;
      const line = lineBySeq.get(Number(row.dataset.seq));
      if (!line || !line.json) return;
      const existing = row.nextElementSibling;
      if (existing && existing.classList.contains('json-expand')) {
        existing.remove();
        row.classList.remove('expanded');
        return;
      }
      row.insertAdjacentElement('afterend', buildJsonExpand(line));
      row.classList.add('expanded');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        toggleErrorDrawer(false);
        toggleMenu(false);
        els.filterInput.blur();
      }
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        els.filterInput.focus();
        els.filterInput.select();
      }
    });

    updateStreamUi();
  }

  init();
})();
