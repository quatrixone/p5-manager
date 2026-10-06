# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

P5 Manager is a self-hosted web console for PS4/PS5 homebrew: payload delivery, file ops, image conversion, Remote Play, and autoload sequences. Two-container Docker stack: Node/Express backend + Python FastAPI sidecar (pyremoteplay).

## Commands

```bash
# Full stack (Docker)
docker compose up -d --build

# Backend (port 3001)
cd backend && npm install && npm run dev

# Frontend (port 3000, proxies API to :3001)
cd frontend && npm install && npm run dev

# Frontend build
cd frontend && npm run build

# Python sidecar (for Remote Play OAuth + RP)
cd pyremoteplay && pip install -r requirements.txt && python server.py
```

## Architecture

### Backend (`backend/src/`)

- **Entry**: `index.js` — Express app, mounts all routers, auto-starts log servers
- **Database**: `db/sqlite.js` — sql.js (SQLite in-memory + file persistence). `DatabaseRepo` class provides `queryOne / queryAll / queryScalar / run / runAndSave`. `getRepo()` singleton.
- **Routes** (`routes/`): One file per resource. All follow `router.METHOD` pattern and use `getRepo()` for DB access.
- **JobQueue** (`lib/JobQueue.js`): Generic async queue with single in-flight worker. Handles pause/resume/retry/clear/move. Used for convert, extract, ftpUpload, install, download jobs. `mountQueueRoutes()` wires standard CRUD onto any router.
- **Log servers**: `routes/logServer.js` (UDP :8080), `routes/kernelLogServer.js` (TCP :3232)
- **Autoload**: `routes/sequences.js` runs saved sequences and holds the watcher that starts a sequence by itself when its console is on but the loader port is closed (`auto_trigger = 'loader_down'`).
- **Update**: `routes/update.js` checks GitHub Releases; the container swap is done on the host by `scripts/p5-update.sh` through a request file in the data dir.

### Frontend (`frontend/src/`)

- **API layer** (`lib/api.js`): Centralized fetch wrapper. `api.get/post/put/patch/del` + `apiSafe` variant that swallows errors. Auto-prepends `/api` prefix.
- **Contexts**: `contexts/PlatformContext.jsx` (platform mode PS4/PS5/auto for the whole tree), `contexts/Ps5StatusContext.jsx` (one shared console status poll).
- **Hooks**: `useApi.js` (fetch helper), `useVisiblePolling.js` (visibility-gated polling).
- **Components** (`components/`): One file per tab/section. `App.jsx` wires routing and global state.

### Data Model

Tables: `profiles`, `payloads`, `autoload_sequences`, `logs`, `settings`, `input_scripts`, `convert_sources`. Schema migrations are `ALTER TABLE ... ADD COLUMN` statements in `db/sqlite.js`, each wrapped in a try/catch that ignores "duplicate column".

### Key Patterns

- Backend route handlers catch their own errors and answer `res.status(...).json({ error })`; there is no shared error middleware.
- Frontend uses `apiSafe` for fire-and-forget polling and `api` for operations requiring error handling.
- exFAT pipeline (`lib/exfat.js`) requires `CAP_SYS_ADMIN` + loop device passthrough (handled in docker-compose.yml).

## Environment

- `PORT` — backend port (default 3001)
- `PYREMOTEPLAY_SIDECAR_URL` — sidecar URL (default http://127.0.0.1:9555)
- `DATA_DIR` — internal data directory (database; default /app/data in the image)
- `USER_DATA_DIR` — payloads, downloads and mkpfs work files (default /data)
- `NODE_ENV=production` — enables static file serving + PWA service worker
