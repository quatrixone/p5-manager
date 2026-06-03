import { Router } from 'express';
import dgram from 'dgram';
import crypto from 'crypto';
import { getDatabase } from '../db/sqlite.js';

const router = Router();

// Capture state management
let captureState = {
  active: false,
  credential: null,
  ip: null,
  timestamp: null,
  error: null
};

// Discovery / status now run exclusively through the Python sidecar
// (pyremoteplay) for single-host queries, plus native UDP broadcast for /scan
// (kept fully chiaki-cli free).
const SIDECAR_URL = process.env.CHIAKI_SIDECAR_URL || 'http://127.0.0.1:9555';
async function sidecarDiscover(ip) {
  const res = await fetch(`${SIDECAR_URL}/discover?ip=${encodeURIComponent(ip)}`, { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `sidecar ${res.status}`);
  return data;
}

const PS5_DISCOVERY_PORT = 987;
const PS5_CONTROL_PORT = 9295;
const PS5_PAIRING_PORT = 9302;

const CHIAKI_MAGIC = Buffer.from('46415954', 'hex');

// Native wake function using dgram instead of chiaki-cli
async function sendPs5Wake(ip, credential) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    // Build proper PS5 wake packet (based on ps5-wake source)
    // Format has all the fields: client-type, auth-type, model, app-type, user-credential
    const message = `WAKEUP * HTTP/1.1\nclient-type:vr\nauth-type:R\nmodel:m\napp-type:r\nuser-credential:${credential}\ndevice-discovery-protocol-version:00030010\n`;
    const packet = Buffer.from(message, 'ascii');

    // Use port 9302 (same as ps5-wake)
    const WAKE_PORT = 9302;

    sock.on('error', (err) => {
      sock.close();
      reject(err);
    });

    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, 0, packet.length, WAKE_PORT, ip, (err) => {
        if (err) {
          sock.close();
          reject(err);
        } else {
          console.log(`Wake packet sent to ${ip}:${WAKE_PORT}`);
          sock.close();
          resolve();
        }
      });
    });
  });
}

function buildRegistrationRequest(sessionId) {
  const version = Buffer.from([0x01, 0x01, 0x00, 0x00]);
  const requestType = Buffer.from([0x00]);
  const sessionIdBytes = Buffer.from(sessionId, 'hex');
  const clientId = crypto.randomBytes(16).toString('hex');

  const packet = Buffer.concat([
    CHIAKI_MAGIC,
    version,
    requestType,
    Buffer.from([sessionIdBytes.length]),
    sessionIdBytes,
    Buffer.from(clientId)
  ]);

  return packet;
}

function buildPinConfirmation(sessionId, pin) {
  const version = Buffer.from([0x01, 0x01, 0x00, 0x00]);
  const requestType = Buffer.from([0x01]);
  const sessionIdBytes = Buffer.from(sessionId, 'hex');
  const pinBytes = Buffer.from(pin.padStart(4, '0').slice(0, 4));

  const packet = Buffer.concat([
    CHIAKI_MAGIC,
    version,
    requestType,
    Buffer.from([sessionIdBytes.length]),
    sessionIdBytes,
    pinBytes
  ]);

  return packet;
}

function sendUdpPacket(packet, host, port = PS5_DISCOVERY_PORT, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('error', (err) => {
      sock.close();
      reject(err);
    });

    const timeoutId = setTimeout(() => {
      sock.close();
      reject(new Error('Timeout'));
    }, timeout);

    sock.on('message', (msg, rinfo) => {
      clearTimeout(timeoutId);
      sock.close();
      resolve(msg);
    });

    sock.bind(undefined, '0.0.0.0', () => {
      sock.send(packet, 0, packet.length, port, host, (err) => {
        if (err) {
          clearTimeout(timeoutId);
          sock.close();
          reject(err);
        }
      });
    });
  });
}

router.post('/capture-credential', async (req, res) => {
  try {
    const { ip } = req.body;

    // Reset capture state
    captureState = {
      active: true,
      credential: null,
      ip: ip || null,
      timestamp: new Date().toISOString(),
      error: null
    };

    const captureSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const CAPTURE_PORT = 9302;

    captureSocket.on('error', (err) => {
      captureState.active = false;
      captureState.error = err.message;
      captureSocket.close();
      res.status(500).json({ success: false, error: err.message });
    });

    captureSocket.on('message', (msg, rinfo) => {
      const message = msg.toString().replace(/\0/g, '');

      if (message.includes('SRCH')) {
        // Respond as PS5 in standby - this triggers chiaki-ng to send WAKEUP
        const response = `HTTP/1.1 620 Server Standby
host-id:68286C072302
host-name:PS5-248
host-type:PS5
host-request-port:${CAPTURE_PORT}
device-discovery-protocol-version:00030010
`;
        const respBuf = Buffer.from(response);
        captureSocket.send(respBuf, 0, respBuf.length, rinfo.port, rinfo.address, (err) => {
          // Ignore send errors
        });
      }
      else if (message.includes('WAKEUP')) {
        // Extract user-credential from wake packet (same format as ps5-wake)
        const match = message.match(/user-credential:([^\n]+)/);
        if (match) {
          captureState.credential = match[1].trim();
          captureState.active = false;
          captureSocket.close();

          // Auto-save to profile if IP provided
          if (ip) {
            const db = getDatabase();
            const stmt = db.prepare('UPDATE profiles SET credential = ? WHERE ip_address = ?');
            stmt.run([captureState.credential, ip]);
            stmt.free();
          }

          res.json({
            success: true,
            credential: captureState.credential,
            message: 'Credential captured and saved to profile'
          });
        }
      }
    });

    captureSocket.bind(CAPTURE_PORT, () => {
      captureSocket.setBroadcast(true);
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (captureState.active) {
        captureState.active = false;
        captureSocket.close();
        res.status(500).json({ success: false, error: 'Capture timeout - no credential received' });
      }
    }, 60000);
  } catch (err) {
    captureState.active = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/capture-status', (req, res) => {
  res.json({
    active: captureState.active,
    credential: captureState.credential,
    ip: captureState.ip,
    timestamp: captureState.timestamp,
    error: captureState.error
  });
});

router.post('/capture-stop', (req, res) => {
  captureState.active = false;
  res.json({
    success: true,
    credential: captureState.credential,
    message: captureState.credential ? 'Capture stopped with credential' : 'Capture stopped - no credential'
  });
});

router.get('/pairstatus', async (req, res) => {
  try {
    const { ip } = req.query;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    try {
      await sendUdpPacket(Buffer.concat([CHIAKI_MAGIC, Buffer.from([0x00, 0x00, 0x00, 0x00])]), ip, PS5_DISCOVERY_PORT, 3000);
      res.json({ success: true, paired: false, ip });
    } catch (err) {
      res.json({ success: false, paired: false, ip, error: err.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pair/init', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    const sessionId = crypto.randomBytes(32).toString('hex');
    const packet = buildRegistrationRequest(sessionId);

    try {
      await sendUdpPacket(packet, ip, PS5_DISCOVERY_PORT, 8000);
      res.json({ success: true, sessionId, message: 'Enter PIN on PS5 screen' });
    } catch (err) {
      res.status(500).json({ success: false, error: 'No response from PS5. Make sure PS5 is showing PIN.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pair/confirm', async (req, res) => {
  try {
    const { ip, pin, sessionId } = req.body;
    if (!ip || !pin || !sessionId) {
      return res.status(400).json({ success: false, error: 'IP, PIN, and sessionId required' });
    }

    const packet = buildPinConfirmation(sessionId, pin);

    try {
      await sendUdpPacket(packet, ip, PS5_DISCOVERY_PORT, 8000);
      res.json({ success: true, message: 'PS5 paired successfully!' });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Pairing failed. Invalid PIN or PS5 not responding.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/wake', async (req, res) => {
  try {
    const { ip, credential } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    let credToUse = credential;

    // If no credential provided, fetch from profile
    if (!credToUse) {
      const db = getDatabase();
      const stmt = db.prepare('SELECT credential FROM profiles WHERE ip_address = ?');
      stmt.bind([ip]);
      if (stmt.step()) {
        const profile = stmt.getAsObject();
        credToUse = profile.credential;
      }
      stmt.free();
    }

    if (!credToUse) {
      return res.status(400).json({ success: false, error: 'Credential required' });
    }

    // Decode base64 credential if needed
    let credDecoded = credToUse;
    try {
      // Check if it looks like base64 (contains = or has valid base64 charset)
      // Skip if credential is all digits (chiaki-ng format)
      if (!/^\d+$/.test(credToUse) && (credToUse.includes('=') || /^[A-Za-z0-9+/]+$/.test(credToUse))) {
        const decoded = Buffer.from(credToUse, 'base64').toString('hex');
        if (decoded.length >= 8) {
          credDecoded = decoded.slice(0, 8);
        }
      }
    } catch (e) {
      // Use as-is if decode fails
    }

    await sendPs5Wake(ip, credDecoded);
    res.json({ success: true, message: `Wake packet sent to ${ip}` });
  } catch (err) {
    console.error('Wake error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/launch', async (req, res) => {
  try {
    const { ip, titleId, name } = req.body;
    if (!ip || !titleId) {
      return res.status(400).json({ success: false, error: 'IP and titleId required' });
    }

    res.json({ success: false, error: 'Launch requires full chiaki library' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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