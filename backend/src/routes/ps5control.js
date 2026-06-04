import { Router } from 'express';
import dgram from 'dgram';

const router = Router();

// Discovery / status run through the Python sidecar (pyremoteplay) for
// single-host queries, plus native UDP broadcast for /scan. All wake and
// credential-capture functionality moved to /api/remoteplay/* (which uses the
// sidecar's DDP WAKEUP + DDP LAUNCH packets driven by the stored PSN account
// id - no manual credential capture needed any more).
const SIDECAR_URL = process.env.CHIAKI_SIDECAR_URL || 'http://127.0.0.1:9555';
async function sidecarDiscover(ip) {
  const res = await fetch(`${SIDECAR_URL}/discover?ip=${encodeURIComponent(ip)}`, { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `sidecar ${res.status}`);
  return data;
}

const PS5_DISCOVERY_PORT = 987;

const CHIAKI_MAGIC = Buffer.from('46415954', 'hex');

router.post('/input', async (req, res) => {
  try {
    const { ip, button, action = 'tap', duration_ms = 80 } = req.body;
    if (!ip || !button) {
      return res.status(400).json({ success: false, error: 'IP and button required' });
    }
    // Delegate to the Remote Play sidecar via the /api/remoteplay/quick-input
    // route, which transparently auto-starts (and caches) the RP session for
    // this IP using stored pair credentials. Keeps the legacy ScriptRunner UI
    // working without it knowing about chiaki sessions.
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/remoteplay/quick-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, button, action, duration_ms }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.success === false) {
      return res.status(r.status || 502).json({ success: false, error: data.error || `quick-input ${r.status}` });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const { ip } = req.query;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    try {
      const data = await sidecarDiscover(ip);
      return res.json({
        success: true,
        ip,
        status: data.status || data.status_code || 'unknown',
        host_name: data.host_name,
        host_type: data.host_type,
        host_id: data.host_id,
        running_app: data.running_app,
        source: 'sidecar',
      });
    } catch (e) {
      return res.json({ success: false, ip, status: 'unreachable', error: e.message });
    }
  } catch (err) {
    res.json({ success: false, ip: req.query.ip, error: err.message, status: 'unreachable' });
  }
});

router.get('/scan', async (req, res) => {
  try {
    const timeoutMs = (parseInt(req.query.timeout) || 5) * 1000;
    // FAYT discovery packet broadcast (same wire format chiaki-cli used to send).
    const packet = Buffer.concat([CHIAKI_MAGIC, Buffer.from([0x00, 0x00, 0x00, 0x00])]);
    const found = await broadcastDiscovery(packet, timeoutMs);
    const devices = found.map((d) => ({
      name: d.hostName || 'Unknown',
      type: d.hostType || 'Unknown',
      hostId: d.hostId || '',
      ip: d.ip,
      port: d.hostRequestPort || 997,
      state: d.state || 'Unknown',
      runningApp: d.runningApp || '',
    }));
    res.json({ success: true, devices });
  } catch (err) {
    res.json({ success: false, error: err.message, devices: [] });
  }
});

router.post('/scan-subnet', async (req, res) => {
  try {
    const { subnet, timeout = 1, concurrency = 50 } = req.body;
    if (!subnet) {
      return res.status(400).json({ success: false, error: 'Subnet required (e.g. 10.0.2.0/24)' });
    }

    const [baseIp] = subnet.split('/');
    const baseParts = baseIp.split('.');
    if (baseParts.length !== 4) {
      return res.status(400).json({ success: false, error: 'Invalid subnet format' });
    }

    const basePrefix = baseParts.slice(0, 3).join('.');

    const scanIp = async (ip) => {
      try {
        const data = await sidecarDiscover(ip);
        if (!data || (!data.host_name && !data.status_code)) return null;
        return {
          name: data.host_name || 'Unknown',
          type: data.host_type || 'Unknown',
          hostId: data.host_id || '',
          ip,
          port: 997,
          state: data.status || (data.status_code === 200 ? 'ready' : data.status_code === 620 ? 'standby' : 'unknown'),
          runningApp: data.running_app || '',
        };
      } catch (_) {
        return null;
      }
    };

    const ips = [];
    for (let i = 1; i < 255; i++) {
      ips.push(`${basePrefix}.${i}`);
    }

    const discovered = [];
    for (let i = 0; i < ips.length; i += concurrency) {
      const batch = ips.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(ip => scanIp(ip)));
      for (const result of results) {
        if (result) discovered.push(result);
      }
    }

    res.json({ success: true, devices: discovered });
  } catch (err) {
    res.json({ success: false, error: err.message, devices: [] });
  }
});

function broadcastDiscovery(packet, timeout) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const devices = [];
    let timedOut = false;

    sock.on('error', (err) => {
      sock.close();
      reject(err);
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      sock.close();
    }, timeout);

    sock.on('message', (msg, rinfo) => {
      const device = parseDiscoveryResponse(msg, rinfo);
      if (device) {
        devices.push(device);
      }
    });

    sock.bind(undefined, '0.0.0.0', () => {
      sock.setBroadcast(true);
      sock.send(packet, 0, packet.length, PS5_DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) {
          clearTimeout(timeoutId);
          sock.close();
          reject(err);
        }
      });
    });

    setTimeout(() => {
      if (!timedOut) {
        clearTimeout(timeoutId);
        sock.close();
      }
    }, timeout + 100);

    sock.on('close', () => {
      resolve(devices);
    });
  });
}

function parseDiscoveryResponse(msg, rinfo) {
  try {
    const message = msg.toString();
    const lines = message.split('\n');
    const device = { ip: rinfo.address };

    for (const line of lines) {
      if (line.startsWith('host-name:')) {
        device.hostName = line.split(':').slice(1).join(':').trim();
      } else if (line.startsWith('host-type:')) {
        device.hostType = line.split(':').slice(1).join(':').trim();
      } else if (line.startsWith('host-id:')) {
        device.hostId = line.split(':').slice(1).join(':').trim();
      } else if (line.startsWith('host-request-port:')) {
        device.hostRequestPort = parseInt(line.split(':').slice(1).join(':').trim());
      } else if (line.startsWith('running-app-name:')) {
        device.runningApp = line.split(':').slice(1).join(':').trim();
      } else if (line.startsWith('running-app-titleid:')) {
        device.runningTitleId = line.split(':').slice(1).join(':').trim();
      } else if (line.startsWith('HTTP')) {
        const code = line.match(/HTTP\/1\.1\s+(\d+)/);
        if (code) {
          device.state = code[1] === '200' ? 'ready' : code[1] === '620' ? 'standby' : 'unknown';
        }
      }
    }

    return device.hostName ? device : null;
  } catch (err) {
    return null;
  }
}

router.get('/arp', async (req, res) => {
  try {
    const { ip } = req.query;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP required' });
    }

    // Ping to populate ARP
    const { exec } = await import('child_process');
    await new Promise((resolve) => {
      exec(`ping -c 1 -W 1 ${ip}`, () => resolve());
    });

    // Read ARP table
    const arpOutput = await new Promise((resolve) => {
      exec(`ip neigh show ${ip}`, (err, stdout) => resolve(err ? '' : stdout));
    });

    const macMatch = arpOutput.match(/lladdr\s+([0-9a-f:]+)/i);
    res.json({ success: true, ip, mac: macMatch ? macMatch[1] : null });
  } catch (err) {
    res.json({ success: false, error: err.message, mac: null });
  }
});

export default router;