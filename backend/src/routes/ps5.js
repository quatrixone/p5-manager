import express from 'express';
import fs from 'fs';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const router = express.Router();

// pyremoteplay sidecar URL (host-networked in compose). Used as a
// fallback for the /status probe: TCP payload ports (lua/elf listeners
// at 9021/9020/8080/6970) are only open while a payload is actually
// running on the PS5. When the console is awake but idle, all four are
// closed — the old probe then reported `reachable: false`, which made
// the topbar pill flip to "offline" even though pyremoteplay's UDP
// discovery could still see the PS5. We now consult the sidecar after a
// failed TCP scan so the indicator reflects discoverability, not just
// payload-listener presence.
const SIDECAR_URL = process.env.PYREMOTEPLAY_SIDECAR_URL
  || process.env.CHIAKI_SIDECAR_URL
  || 'http://127.0.0.1:9555';

// Per-IP discover cache. PS5 discovery uses UDP and typically takes
// 100-500ms; the topbar polls every 10s, and PS5Control polls on its
// own, so without caching we'd hit the sidecar twice every 10s per
// open tab. 6s TTL keeps the topbar feeling live while still
// collapsing duplicate calls.
const DISCOVER_CACHE_TTL_MS = 6_000;
const discoverCache = new Map(); // ip -> { ts, data }
const discoverInFlight = new Map(); // ip -> Promise<data|null>

async function probeDiscover(ip) {
  const cached = discoverCache.get(ip);
  if (cached && (Date.now() - cached.ts) < DISCOVER_CACHE_TTL_MS) {
    return cached.data;
  }
  if (discoverInFlight.has(ip)) return discoverInFlight.get(ip);
  const promise = (async () => {
    const controller = new AbortController();
    // 2s is enough for a PS5 on the same LAN (typical response <500ms)
    // and keeps the worst-case "fully offline" probe at ~4s total
    // (2s tcp scan + 2s discover) so the topbar's 10s poll never piles up.
    const t = setTimeout(() => controller.abort(), 2000);
    try {
      const r = await fetch(`${SIDECAR_URL}/discover?ip=${encodeURIComponent(ip)}`, {
        signal: controller.signal,
      });
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      if (!data || typeof data !== 'object') return null;
      // pyremoteplay reports status='Ok' (awake) or 'Standby' (rest);
      // either counts as "the box is on the network", which is what we
      // need to say "not offline".
      discoverCache.set(ip, { ts: Date.now(), data });
      return data;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(t);
      discoverInFlight.delete(ip);
    }
  })();
  discoverInFlight.set(ip, promise);
  return promise;
}

router.post('/send', async (req, res) => {
  try {
    const { ip, port, filepath } = req.body;

    if (!ip || !filepath) {
      return res.status(400).json({ error: 'IP and filepath required' });
    }

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileData = fs.readFileSync(filepath);
    const targetPort = port || 9021;

    log('info', `Sending payload to ${ip}:${targetPort}`);

    const net = await import('net');
    const client = new net.Socket();

    await new Promise((resolve, reject) => {
      client.connect(targetPort, ip, () => {
        client.write(fileData, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      client.on('error', reject);
      client.setTimeout(15000);
    });

    client.end();
    client.destroy();

    log('info', `Payload sent successfully to ${ip}`);

    res.json({ success: true, message: `Sent to ${ip}:${targetPort}` });
  } catch (error) {
    log('error', `PS5 send failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/status/:ip', async (req, res) => {
  try {
    const { ip } = req.params;
    // Ports we probe to decide "is something payload-y listening on this
    // console". An open listener here means the box is definitely awake.
    //   9021 - PS5 elfldr        (ELF payloads)
    //   9026 - PS5 Lua listener  (.lua exploit chain)
    //   9020 - PS4 GoldHEN       (.bin payloads, also the PS4 elf path)
    //   8080 - PS4 web exploit host
    //   6970 - etaHEN file/util server
    const ports = [9021, 9026, 9020, 8080, 6970];

    // Status check is polled every few seconds from the UI - logging every
    // probe spammed the unified Logs view, so it's intentionally silent now.

    const net = await import('net');

    // Check multiple ports - if any is open, PS5 is reachable with payload
    const checkPort = (port) => new Promise((resolve) => {
      const client = new net.Socket();
      client.setTimeout(2000);

      client.on('connect', () => {
        client.destroy();
        resolve({ port, reachable: true });
      });

      client.on('timeout', () => {
        client.destroy();
        resolve({ port, reachable: false });
      });

      client.on('error', () => {
        client.destroy();
        resolve({ port, reachable: false });
      });

      client.connect(port, ip);
    });

    // Check all ports in parallel
    const results = await Promise.all(ports.map(checkPort));
    const openPort = results.find(r => r.reachable);

    // Fallback: even if no payload listener is up, pyremoteplay's UDP
    // discovery can still see the PS5 (awake or in standby). We only
    // pay this probe when the TCP scan turned up nothing, so the fast
    // path (payload running) is unchanged.
    let discoverResult = null;
    if (!openPort) {
      discoverResult = await probeDiscover(ip);
    }

    const reachableViaPayload = !!openPort;
    const reachableViaDiscover = !!(discoverResult && (discoverResult.status || discoverResult.status_code));
    const isReachable = reachableViaPayload || reachableViaDiscover;

    // Normalise the sidecar's host_type ("PS5" / "PS4") into our internal
    // lowercase platform tag so the frontend never has to worry about
    // capitalization or vendor strings drifting.
    const rawHostType = discoverResult ? (discoverResult.host_type || null) : null;
    const consoleType = rawHostType
      ? (String(rawHostType).toUpperCase().includes('PS4') ? 'ps4'
        : (String(rawHostType).toUpperCase().includes('PS5') ? 'ps5' : null))
      : null;

    // Best-effort auto-fill of the matching profile.console_type field when
    // (a) discovery actually told us the platform, AND (b) the profile
    // either has no console_type yet or has one that disagrees with the
    // live console. Single-statement UPDATE, swallow any DB error so a
    // status poll never fails for a write-side problem.
    if (consoleType) {
      try {
        const db = getDatabase();
        const stmt = db.prepare('SELECT id, console_type FROM profiles WHERE ip_address = ?');
        stmt.bind([ip]);
        const matches = [];
        while (stmt.step()) matches.push(stmt.getAsObject());
        stmt.free();
        let changed = false;
        for (const row of matches) {
          if (row.console_type !== consoleType) {
            db.run('UPDATE profiles SET console_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [consoleType, row.id]);
            changed = true;
          }
        }
        if (changed) saveDatabase();
      } catch (_) { /* best-effort, ignore */ }
    }

    res.json({
      ip,
      reachable: isReachable,
      openPort: openPort ? openPort.port : null,
      via: reachableViaPayload ? 'payload' : (reachableViaDiscover ? 'discover' : null),
      discover_status: discoverResult ? (discoverResult.status || null) : null,
      host_name: discoverResult ? (discoverResult.host_name || null) : null,
      host_type: rawHostType,
      console_type: consoleType,
      running_app: discoverResult ? (discoverResult.running_app || null) : null,
      portsChecked: ports,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log('error', `PS5 status check failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;