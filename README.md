# PS5WebPayload Manager

Web-based manager for downloading and sending PS5 payloads (LUA and ELF files).

**Key Features:**
- Fetch payloads directly from GitHub (releases or blob URLs)
- Upload custom payloads from your computer
- Automatic port detection (LUA payloads use port 9026, ELF use 9021)
- Built-in LUA Log Server for receiving debug output from payloads
- Multiple PS5 profile support
- **Persistent Storage** - all data (profiles, payloads, settings) survives container rebuilds
- **Auto-Default** - first profile automatically becomes default

**Requirements:**
- PS5 console on same network
- Star Wars Racer Revenge (CUSA03474 USA or CUSA03492 EU)
- PS5 firmware 12.70 or lower for LUA payloads

## Quick Start

### Docker Compose (Recommended)

```bash
git clone https://github.com/psdeviant/ps5webpayload-manager.git
cd ps5webpayload-manager
docker-compose up -d
```

The app will be available at `http://your-server:3001`

### Manual (Node.js)

```bash
# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Start backend (port 3001)
cd backend && npm run dev

# In another terminal, start frontend (port 3000)
cd frontend && npm run dev
```

Or for production:
```bash
# Build frontend
cd frontend && npm run build

# Start backend (serves built frontend)
cd backend && npm run dev
```

## Usage

1. **Add a PS5 Profile** - Go to Settings tab and add your PS5 IP address and MAC address
   - First profile is automatically set as default
   - No need to click "Set Default" if you only have one profile
2. **Fetch Payloads** - Use Fetch from GitHub URL or Upload File
3. **Send Payload** - Go to Send tab, select payload and click Send
4. **LUA Log Server** - Go to Logs tab for receiving payload debug output
5. **Settings** - Go to Settings tab for profiles management and backup/restore

### Supported GitHub URLs

```bash
# Latest release from a repo
https://github.com/owner/repo/releases

# Specific release tag
https://github.com/owner/repo/releases/tag/v1.05

# Direct file blob
https://github.com/owner/repo/blob/main/payloads/file.lua

# Raw file URL
https://raw.githubusercontent.com/owner/repo/main/payloads/file.lua
```

## Port Configuration

| Payload Type | Port  |
|-------------|-------|
| LUA (.lua)  | 9026  |
| ELF (.elf)  | 9021  |

## Persistent Storage

All application data is stored in Docker volumes and persists across container rebuilds:

```bash
# Data location
./data/
  payloads.db    # SQLite database (profiles, payloads, settings)
  payloads/      # Uploaded payload files

# To backup
tar -czf backup.tar.gz ./data/

# To restore
tar -xzf backup.tar.gz
```

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** React + Vite
- **Database:** SQLite (sql.js) with persistent Docker volume
- **Log Server:** UDP (port 8080)

## License

MIT