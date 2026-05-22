# PS5WebPayload Manager

Web-based manager for downloading and sending PS5 payloads (LUA and ELF files).

## Tech Stack

- **Backend:** Node.js + Express (ES Modules)
- **Frontend:** React + Vite
- **Database:** SQLite (sql.js)
- **Container:** Docker

## Quick Start

```bash
# Start with Docker
docker compose up -d

# Access at http://localhost:3000
```

## Development

```bash
# Frontend
cd frontend && npm install && npm run dev

# Backend
cd backend && npm install && npm run dev
```

## Key Files

- `backend/src/index.js` - Express server, API routes
- `backend/src/db/sqlite.js` - Database initialization
- `backend/src/routes/payloads.js` - Payload management endpoints
- `backend/src/routes/logServer.js` - UDP log server for LUA payloads
- `frontend/src/App.jsx` - Main React component with tab navigation

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/payloads` | List all payloads |
| POST | `/api/payloads/fetch-url` | Fetch from GitHub URL |
| POST | `/api/payloads/upload` | Upload payload |
| POST | `/api/payloads/send/:id` | Send payload to PS5 |
| GET | `/api/profiles` | List profiles |
| POST | `/api/profiles` | Create profile |
| POST | `/api/ps5/status/:ip` | Check PS5 reachability |
| GET | `/api/logs` | Get system logs |
| GET | `/api/logserver/status` | Log server status |
| POST | `/api/logserver/start` | Start log server |
| GET/POST | `/api/backup` | Export/import backup |

## Port Configuration

| Payload Type | Port |
|-------------|------|
| LUA (.lua)  | 9026 |
| ELF (.elf)  | 9021 |

## Requirements

- PS5 console on same network
- Star Wars Racer Revenge game for LUA payloads
- PS5 firmware 12.70 or lower