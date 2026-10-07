import express from 'express';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { getRepo, log } from '../db/sqlite.js';
import { payloadsDir } from '../lib/paths.js';
import { discoverConsole } from '../lib/consoleStatus.js';

const router = express.Router();

const PAYLOADS_ROOT = path.resolve(payloadsDir) + path.sep;

// When no payload listener answers, the console may still be on (or in rest
// mode): its DDP answer, through the Remote Play sidecar, says so. The TCP
// payload ports (lua/elf listeners) are only open while a payload is
// running; an awake, idle console has them all closed. lib/consoleStatus.js
// shares one search per poll cycle and rides out a single lost answer.
function profileHostType(ip) {
  try {
    const row = getRepo().queryOne('SELECT console_type FROM profiles WHERE ip_address = ? LIMIT 1', [ip]);
    return row?.console_type === 'ps4' ? 'PS4' : row?.console_type === 'ps5' ? 'PS5' : null;
  } catch (_) {
    return null;
  }
}

// The port a payload host last answered on, per console: a busy loader can
// miss one connect, so it gets a second, longer chance before the console
// stops counting as running a payload.
const lastOpenPort = new Map(); // ip -> { port, at }
const LAST_OPEN_MS = 60_000;

router.post('/send', async (req, res) => {
  try {
    const { ip, port, filepath } = req.body;

    if (!ip || !filepath) {
      return res.status(400).json({ error: 'IP and filepath required' });
    }
    if (net.isIP(String(ip)) === 0) {
      return res.status(400).json({ error: 'Invalid IP address' });
    }

    // Whitelist filepath to payloadsDir - never accept arbitrary host paths.
    // Resolve symlinks too, so a malicious symlink in payloadsDir cannot
    // escape the whitelist at read time.
    let safeFilepath;
    try {
      const real = fs.realpathSync(String(filepath));
      if (!real.startsWith(PAYLOADS_ROOT)) {
        return res.status(400).json({ error: 'filepath must be inside payloadsDir' });
      }
      safeFilepath = real;
    } catch (_) {
      return res.status(400).json({ error: 'Invalid filepath' });
    }

    if (!fs.existsSync(safeFilepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileData = fs.readFileSync(safeFilepath);
    const targetPort = port || 9021;

    log('info', `Sending payload to ${ip}:${targetPort}`);

    const netmod = await import('net');
    const client = new netmod.Socket();

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
    const checkPort = (port, timeout = 2000) => new Promise((resolve) => {
      const client = new net.Socket();
      client.setTimeout(timeout);

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
    const results = await Promise.all(ports.map((p) => checkPort(p)));
    let openPort = results.find(r => r.reachable);
    const last = lastOpenPort.get(ip);
    if (!openPort && last && Date.now() - last.at < LAST_OPEN_MS) {
      const again = await checkPort(last.port, 3500);
      if (again.reachable) openPort = again;
    }
    if (openPort) lastOpenPort.set(ip, { port: openPort.port, at: Date.now() });
    else lastOpenPort.delete(ip);

    // Fallback: even if no payload listener is up, the sidecar's UDP
    // discovery can still see the PS5 (awake or in standby). We only
    // pay this probe when the TCP scan turned up nothing, so the fast
    // path (payload running) is unchanged.
    let discoverResult = null;
    if (!openPort) {
      discoverResult = await discoverConsole(ip, { hostType: profileHostType(ip) });
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
        const repo = getRepo();
        const matches = repo.queryAll('SELECT id, console_type FROM profiles WHERE ip_address = ?', [ip]);
        let changed = false;
        for (const row of matches) {
          if (row.console_type !== consoleType) {
            repo.run('UPDATE profiles SET console_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [consoleType, row.id]);
            changed = true;
          }
        }
        if (changed) repo.save();
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