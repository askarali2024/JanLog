# JanLog

**A lightweight, self-hosted real-time log tailer and error watcher** — a web-based alternative to `tail -f` and `lnav`. Point it at a log file or directory and watch lines stream into a clean, developer-focused dark UI in under a second.

- ⚡ **Real-time** — Server-Sent Events push every appended byte to connected browsers with sub-second latency.
- 🧠 **Memory-safe** — only *newly appended* bytes are ever read (byte-offset `createReadStream`), so multi-GB log files never land in memory. Rotation and truncation are handled gracefully.
- 🎯 **Zero-config discovery** — watch files, directories, or globs via `LOG_PATHS`; new files appearing in watched directories are picked up automatically.
- 🔍 **Instant filtering** — text or `/regex/` search with case-sensitivity and regex toggles, plus live-count level pills (`ERROR` / `WARN` / `INFO` / `DEBUG`) that understand both plain-text and structured JSON logs (Pino, Winston, Docker JSON…).
- 🧩 **JSON-aware** — structured lines render as a compact `timestamp · level · message` summary; click any line to expand a syntax-highlighted, pretty-printed drawer with one-click **Copy Line / JSON**.
- 🚨 **Error watcher** — a live error badge and jump-list drawer so you can hop straight to stack traces instead of scrolling through thousands of `INFO` lines.
- 🎛 **Bounded rendering** — the browser caps rendered lines at `MAX_BUFFER_LINES` (default 2000), so the UI stays fast during heavy bursts.
- 📦 **Minimal** — one dependency (Express), static vanilla-JS frontend, no build step.

---

## Architecture

```
        ┌────────────────────────────────────────────────────────────┐
        │                      Browser (SPA)                         │
        │   JanLog UI · filters · level pills · JSON expand · drawer  │
        └───────────▲───────────────────────────────▲────────────────┘
                    │ GET / (static assets)          │ GET /api/events  (SSE)
                    │ GET /api/sources/tail          │ POST /api/paths
        ┌───────────┴───────────────────────────────┴────────────────┐
        │                  Express server (Node.js)                  │
        │                                                            │
        │   ┌─────────────────────┐      ┌────────────────────────┐  │
        │   │   REST + SSE hub    │◀────▶│   LogManager/LogSource │  │
        │   │  (per-client push) │      │  · per-source ring buf │  │
        │   └─────────────────────┘      │  · level detection     │  │
        │                                │  · JSON parsing        │  │
        │                                └───────────┬────────────┘  │
        │              2s safety poll + fs.watch(dir)│               │
        │            byte-offset fs.createReadStream │               │
        └────────────────────────────────────────────┼───────────────┘
                                                     ▼
     ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐
     │   app.log      │   │   api.json     │   │ rotated files,   │
     │ (plain text)   │   │ (pino JSON)    │   │ truncation, new  │
     └────────────────┘   └────────────────┘   │ files in dirs…   │
                                              └──────────────────┘
```

**How appends are read:** each source tracks its byte `offset`. On a file change (or the 2s safety poll), the server stats the file and reads only `[offset, size)` via `fs.createReadStream`. A partial trailing line (no newline yet) is carried forward and completed by the next append. If `size < offset` the file was truncated or rotated — the offset resets to 0 and the new content is re-read from the start. Deleted files are flagged *missing* and resume if the path reappears.

## Quick start

```bash
git clone <repo> janlog && cd janlog
npm install

# terminal 1 — generate realistic demo traffic (plain-text + JSON logs)
npm run demo-logs

# terminal 2 — start JanLog
npm start
```

Open **http://localhost:8002** — you'll see two sources (`app.log`, `api.json`) streaming live, with occasional `WARN`s and `ERROR`s (including stack traces) to explore the level pills, JSON expansion, and the error drawer.

### Point it at real logs

```bash
LOG_PATHS=/var/log/nginx/error.log,./my-app/*.log PORT=8002 npm start
```

Or add paths at runtime via the **Add Log Path** input in the source switcher (supports files, directories and globs — disable with `ALLOW_UI_PATHS=false`).

### Docker

```bash
docker build -t janlog .

# tail the host's nginx logs
docker run --rm -p 8002:8002 -v /var/log/nginx:/logs:ro -e LOG_PATHS=/logs janlog

# or with defaults (expects files under /logs)
docker run --rm -p 8002:8002 -v "$PWD/logs:/logs" janlog
```

## Remote server logs

There are four practical patterns, depending on how much you want to install on the remote server.

### Option A — Run JanLog on the server, tunnel the port (recommended)

Install once on the remote server, then reach it through SSH so nothing is exposed publicly:

```bash
# on the remote server
git clone https://github.com/askarali2024/JanLog && cd JanLog && npm install
LOG_PATHS=/var/log/nginx,/var/log/myapp ALLOW_UI_PATHS=false npm start

# keep it alive
pm2 start server/index.js --name janlog
```

```bash
# on your laptop — forward the port over SSH
ssh -L 8002:localhost:8002 user@your-server
```

Then open `http://localhost:8002`. Full live streaming with sub-second latency, since JanLog reads the files locally on the server.

### Option B — Mount the remote logs locally (zero install on server)

```bash
mkdir ~/remote-logs
sshfs user@your-server:/var/log ~/remote-logs
LOG_PATHS="$HOME/remote-logs/**/*.log" npm start
```

`fs.watch` events don't fire over sshfs, but JanLog's built-in 2-second safety poll re-stats every file and reads only the new bytes — so it works, with up to ~2s latency per line.

### Option C — Pipe remote logs into a local file (quick one-off debugging)

```bash
# tail -F on the remote side handles rotation for you
ssh user@your-server "tail -F /var/log/myapp/app.log" >> ./logs/remote-app.log
npm start
```

Nothing to install remotely at all — JanLog just sees a locally growing file.

### Option D — Docker on the server

```bash
docker run -d --name janlog -p 127.0.0.1:8002:8002 \
  -v /var/log:/logs:ro \
  -e LOG_PATHS=/logs \
  -e ALLOW_UI_PATHS=false \
  janlog   # after: docker build -t janlog . on the server
```

Note `-p 127.0.0.1:8002:8002` — binding to loopback only, so it's reachable via SSH tunnel but not from the internet.

### Security checklist for remote setups

- **JanLog has no authentication.** Anyone who can reach the port can read your logs — never expose it directly to the public internet. Always tunnel (`ssh -L`), use a VPN, or put it behind a reverse proxy with auth:

  ```nginx
  location /janlog/ {
      auth_basic "JanLog";
      auth_basic_user_file /etc/nginx/.htpasswd;
      proxy_pass http://127.0.0.1:8002/;
      proxy_http_version 1.1;
      proxy_set_header Connection '';   # needed for SSE
      proxy_buffering off;              # needed for SSE
  }
  ```

- **Set `ALLOW_UI_PATHS=false` on remote servers.** The Add-Path feature accepts any filesystem path, so on a shared box you don't want strangers adding `/etc/...` to the watch list.
- Log files must be readable by the user running JanLog (add your user to the right group, e.g. `adm` on Debian/Ubuntu, or run under `sudo -u syslog`).

**Rule of thumb:** Option A with pm2 for a permanent setup, Option C for quick one-off debugging sessions.

## Configuration

| Variable            | Default  | Description                                                            |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| `PORT`              | `8002`   | HTTP port to listen on.                                                 |
| `LOG_PATHS`         | `./logs` | Comma-separated files, directories or globs (`logs/**/*.log`). Directories are scanned recursively for common log extensions (`.log`, `.txt`, `.json`, `.out`, …) and watched for new files. |
| `INITIAL_TAIL_LINES`| `200`    | Lines tailed from each file when first discovered (read backwards, memory-safe). |
| `MAX_BUFFER_LINES`  | `2000`   | Ring-buffer size per source on the server, and the rendered-line cap in the browser. |
| `ALLOW_UI_PATHS`    | `true`   | Allow adding new watch paths from the web UI (`POST /api/paths`).       |

## UI guide

| Control | What it does |
| --- | --- |
| **Connection badge** | 🟢 `Streaming` / 🟡 `Paused` / 🔴 `Disconnected`. |
| **Source switcher** | Active filename, live file size, and an unread-error badge (click the badge to open the error jump-list). |
| **Stream / Pause** | Freezes the live view for inspection; buffered lines catch up on resume. |
| **Filter box** | Instant text filtering; wrap the query in slashes (`/ERR.*timeout/`) or toggle `.*` for regex, `Aa` for case sensitivity. Matches are highlighted in the stream. Press `/` to focus. |
| **Level pills** | Filter by level with live counts. Levels are auto-detected from plain-text keywords and JSON `level` / `severity` / `lvl` fields (named, pino 10–60, and syslog 0–7 numeric forms). |
| **Wrap / Auto-Scroll** | Toggle line wrapping; auto-scroll unlocks itself when you scroll up and offers a floating *Jump to Latest ↓* pill. |
| **Download** | Snapshots the current **filtered** view to a `.log` file. |
| **JSON lines** | Rendered as `timestamp · LEVEL · message`; click to expand pretty-printed, syntax-highlighted JSON with Copy Line / Copy JSON. |
| **Error drawer** | Jump-list of the 100 most recent errors; clicking an item scrolls to and flashes the line (relaxing filters if needed). |
| **Clear View** | Clears the browser view only — the server buffer and streaming are untouched. |

## API

| Method & Path          | Description |
| ---------------------- | ----------- |
| `GET /api/sources`     | Discovered sources with size, level counts and missing state. |
| `GET /api/sources/tail?id=…&lines=N` | Initial history for a source (server-side ring buffer). |
| `GET /api/events`      | SSE stream: `hello` (config + sources), `line`, `sources`, `stats`. |
| `POST /api/paths`      | `{"path": "…"}` — add a file / directory / glob (if `ALLOW_UI_PATHS`). |

## Notes

- **Security:** JanLog is a development/ops tool intended to run behind a trusted boundary. It serves file contents from configured paths to anyone who can reach the port — don't expose it directly to the public internet (see [Remote server logs](#remote-server-logs) for tunneling and auth-proxy setup).
- **Rotation styles:** both `rename + recreate` (logrotate default) and in-place truncation (`copytruncate`) are handled.
- **File formats:** any text file works; files discovered inside directories must have a log-ish extension (`.log`, `.txt`, `.out`, `.err`, `.json`, `.jsonl`, `.ndjson`, `.trace`). Other files can be watched by naming them explicitly in `LOG_PATHS`.
- Lines are never length-capped; the `MAX_BUFFER_LINES` bound limits line *count*, not length.

## Project structure

```
janlog/
├── server/
│   ├── index.js      # Express app, REST endpoints, SSE hub
│   ├── watcher.js    # LogManager — fs.watch + byte-offset reads, rotation handling
│   ├── logstore.js   # LogSource ring buffer, level/JSON detection, backwards tail
│   ├── glob.js       # Minimal glob support (no extra dependencies)
│   └── config.js     # Environment-variable configuration
├── public/
│   ├── index.html    # SPA shell
│   ├── styles.css    # Dark theme (#0f111a / #181b28 / #6366f1)
│   └── app.js        # SSE client, bounded rendering, filters, drawers
├── scripts/
│   └── demo-logs.js  # Sample log generator (npm run demo-logs)
├── Dockerfile
└── package.json      # single dependency: express
```

## License

MIT
