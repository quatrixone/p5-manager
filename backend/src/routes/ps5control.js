import { Router } from 'express';
import dgram from 'dgram';
import { getDatabase } from '../db/sqlite.js';

const router = Router();

// Discovery / status run through the Python sidecar (pyremoteplay) for
// single-host queries. All wake and credential-capture functionality moved to
// /api/remoteplay/* (which uses the sidecar's DDP WAKEUP + DDP LAUNCH packets
// driven by the stored PSN account id - no manual credential capture needed
// any more).
const SIDECAR_URL = process.env.PYREMOTEPLAY_SIDECAR_URL
  || process.env.CHIAKI_SIDECAR_URL
  || 'http://127.0.0.1:9555';
async function sidecarDiscover(ip) {
  const res = await fetch(`${SIDECAR_URL}/discover?ip=${encodeURIComponent(ip)}`, { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `sidecar ${res.status}`);
  return data;
}

// PS5 listens on UDP 9302 for DDP discovery; PS4 listens on 987. PS5 will NOT
// reply to a discovery packet sent to 987 (and the legacy FAYT binary packet
// is the wrong wire format entirely). The packet body is text:
//   "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n"
const PS5_DISCOVERY_PORT = 9302;
const PS4_DISCOVERY_PORT = 987;
const SRCH_PACKET = Buffer.from(
  'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n',
);

// Read default_subnet from settings (e.g. "10.0.0.0/24") and return the
// directed broadcast address (e.g. "10.0.0.255"). Falls back to the global
// limited broadcast if anything goes wrong.
function getBroadcastAddress(explicitSubnet) {
  let subnet = explicitSubnet;
  if (!subnet) {
    try {
      const db = getDatabase();
      const stmt = db.prepare("SELECT value FROM settings WHERE key='default_subnet'");
      if (stmt.step()) subnet = stmt.getAsObject().value;
      stmt.free();
    } catch (_) {}
  }
  if (!subnet) return '255.255.255.255';
  const [baseIp, prefixStr] = subnet.split('/');
  const prefix = parseInt(prefixStr, 10);
  const octets = baseIp.split('.').map((n) => parseInt(n, 10));
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n)) || Number.isNaN(prefix)) {
    return '255.255.255.255';
  }
  // Compute broadcast = base | ~mask
  const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const bcastInt = (baseInt | (~mask >>> 0)) >>> 0;
  return [
    (bcastInt >>> 24) & 0xff,
    (bcastInt >>> 16) & 0xff,
    (bcastInt >>> 8) & 0xff,
    bcastInt & 0xff,
  ].join('.');
}

// pyremoteplay's local listen port. PS5 will only reply to *unicast* SRCH
// when the source port equals 9303 (broadcasts get a reply regardless).
// Binding here means subnet sweeps actually work; we keep the fallback to an
// ephemeral port in case 9303 is already taken on the host (e.g. the sidecar
// did a discovery half a second earlier and hasn't freed the port yet).
const DDP_LOCAL_PORT = 9303;

// Run a single-socket DDP scan: send SRCH to every (host, port) pair, collect
// replies until the timeout elapses. Used by both /scan (broadcast) and
// /scan-subnet (unicast sweep over 1-254). One socket = no port races and
// scans 254 IPs in seconds instead of minutes.
//
// IMPORTANT: do NOT enable reuseAddr - on Linux, Node combines SO_REUSEADDR
// with SO_REUSEPORT, which makes the kernel load-balance incoming packets
// across any process bound to that port. Even within one process that breaks
// inbound delivery (replies disappear). If 9303 is genuinely in use we fall
// back to an ephemeral port and lose unicast-PS5 replies but still catch
// broadcast replies.
function ddpScan(targets, timeoutMs) {
  return new Promise((resolve) => {
    const devices = new Map();
    const onMessage = (msg, rinfo) => {
      const dev = parseDiscoveryResponse(msg, rinfo);
      if (dev?.hostName) devices.set(rinfo.address, dev);
    };
    // Send in small bursts with a short pacing delay between them. Firing
    // 500+ UDP packets in one synchronous loop tips the kernel send buffer
    // and many - sometimes all - get silently dropped, taking the real
    // replies with them. 30 packets per ~10 ms gives the kernel time to
    // drain its buffer and ICMP unreachable replies to be processed.
    const BURST_SIZE = 30;
    const BURST_GAP_MS = 10;
    const sendAll = (s) => {
      s.setBroadcast(true);
      let i = 0;
      const pump = () => {
        const end = Math.min(i + BURST_SIZE, targets.length);
        for (; i < end; i++) {
          try {
            s.send(SRCH_PACKET, 0, SRCH_PACKET.length, PS5_DISCOVERY_PORT, targets[i], () => {});
            s.send(SRCH_PACKET, 0, SRCH_PACKET.length, PS4_DISCOVERY_PORT, targets[i], () => {});
          } catch (_) {}
        }
        if (i < targets.length) setTimeout(pump, BURST_GAP_MS);
      };
      pump();
    };
    const openSocket = (port) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch (_) {}
        resolve([...devices.values()]);
      };
      sock.on('message', onMessage);
      sock.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && port === DDP_LOCAL_PORT) {
          // Couldn't grab 9303 - retry on an ephemeral port so we still get
          // broadcast replies (PS4s + PS5s on broadcast). Unicast PS5 replies
          // will be lost, but that's acceptable on this rare path.
          try { sock.close(); } catch (_) {}
          openSocket(0);
          return;
        }
        finish();
      });
      sock.bind(port, () => sendAll(sock));
      setTimeout(finish, timeoutMs);
    };
    openSocket(DDP_LOCAL_PORT);
  });
}

router.post('/input', async (req, res) => {
  try {
    const { ip, button, action = 'tap', duration_ms = 80 } = req.body;
    if (!ip || !button) {
      return res.status(400).json({ success: false, error: 'IP and button required' });
    }
    // Delegate to the Remote Play sidecar via the /api/remoteplay/quick-input
    // route, which transparently auto-starts (and caches) the RP session for
    // this IP using stored pair credentials. Keeps the legacy ScriptRunner UI
    // working without it knowing about pyremoteplay sessions.
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

// Broadcast DDP discovery on the LAN. Uses the saved default_subnet (or the
// caller-supplied ?subnet=10.0.0.0/24) to compute a *directed* broadcast like
// 10.0.0.255 - that targets the right NIC even when the host has many docker
// bridges, where 255.255.255.255 gets routed to docker0.
router.get('/scan', async (req, res) => {
  try {
    const timeoutMs = (parseInt(req.query.timeout) || 3) * 1000;
    const subnetOverride = req.query.subnet ? String(req.query.subnet) : null;
    const targets = new Set();
    const directed = getBroadcastAddress(subnetOverride);
    targets.add(directed);
    if (directed !== '255.255.255.255') targets.add('255.255.255.255');
    const found = await ddpScan([...targets], timeoutMs);
    res.json({ success: true, devices: found.map(formatDevice) });
  } catch (err) {
    res.json({ success: false, error: err.message, devices: [] });
  }
});

// Unicast sweep over every host in the subnet. Uses one shared UDP socket so
// the whole /24 finishes in a couple seconds (single-socket = no port races,
// no sidecar round-trips).
router.post('/scan-subnet', async (req, res) => {
  try {
    const { subnet, timeout = 3 } = req.body || {};
    if (!subnet) {
      return res.status(400).json({ success: false, error: 'Subnet required (e.g. 10.0.0.0/24)' });
    }
    const [baseIp, prefixStr] = String(subnet).split('/');
    const baseParts = baseIp.split('.').map((n) => parseInt(n, 10));
    if (baseParts.length !== 4 || baseParts.some((n) => Number.isNaN(n))) {
      return res.status(400).json({ success: false, error: 'Invalid subnet format' });
    }
    const prefix = parseInt(prefixStr || '24', 10);
    if (prefix < 16 || prefix > 30) {
      return res.status(400).json({ success: false, error: 'Prefix must be /16..30' });
    }

    // Enumerate every host address in the subnet (skip network + broadcast).
    const baseInt = ((baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (baseInt & mask) >>> 0;
    const bcast = (network | (~mask >>> 0)) >>> 0;
    const targets = [];
    for (let host = network + 1; host < bcast; host++) {
      targets.push([
        (host >>> 24) & 0xff,
        (host >>> 16) & 0xff,
        (host >>> 8) & 0xff,
        host & 0xff,
      ].join('.'));
    }
    // Also include the directed broadcast so any PS console that prefers
    // broadcasts (some Pro models reply faster) gets picked up too.
    targets.push(getBroadcastAddress(subnet));

    const found = await ddpScan(targets, Math.max(1000, timeout * 1000));
    res.json({ success: true, devices: found.map(formatDevice) });
  } catch (err) {
    res.json({ success: false, error: err.message, devices: [] });
  }
});

function formatDevice(d) {
  return {
    name: d.hostName || 'Unknown',
    type: d.hostType || 'Unknown',
    hostId: d.hostId || '',
    ip: d.ip,
    port: d.hostRequestPort || 997,
    state: d.state || 'Unknown',
    runningApp: d.runningApp || '',
  };
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