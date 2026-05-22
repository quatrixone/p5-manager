# PS5WebPayload Manager

Web-based manager for downloading and sending PS5 payloads (LUA and ELF files).

**Key Features:**
- Fetch payloads directly from GitHub (releases or blob URLs)
- Upload custom payloads from your computer
- Automatic port detection (LUA payloads use port 9026, ELF use 9021)
- Built-in LUA Log Server for receiving debug output from payloads
- Multiple PS5 profile support with default selection
- Network status checking

**Requirements:**
- PS5 console on same network
- Star Wars Racer Revenge (CUSA03474 USA or CUSA03492 EU)
- PS5 firmware 12.00 or lower for LUA payloads

## Quick Start

### Docker Compose (Recommended)

```bash
docker-compose up -d
```

The app will be available at `http://your-server:3000`

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

1. **Add a PS5 Profile** - Go to Profiles tab and add your PS5 IP address
2. **Set Default Profile** - Click "Set Default" on your PS5 profile
3. **Fetch Payloads** - Use Fetch from GitHub URL or Upload File
4. **Send Payload** - Go to Network Send tab, select payload and click Send
5. **LUA Log Server** - Go to LUA log server tab, click Start to begin receiving logs

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

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** React + Vite
- **Database:** SQLite (sql.js)
- **Log Server:** UDP (port 8080)

## License

MIT