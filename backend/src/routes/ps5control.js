import { Router } from 'express';
import { exec } from 'child_process';
import { wakeOnLan } from '../services/wol.js';

const router = Router();

const CHIAKI_TIMEOUT = 15000;

const execLocal = (cmd, args = []) => new Promise((resolve, reject) => {
  exec(`${cmd} ${args.join(' ')}`, { timeout: CHIAKI_TIMEOUT }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr || error.message));
      return;
    }
    resolve(stdout);
  });
});

// ============ WAKE-ON-LAN ============

router.post('/wol', async (req, res) => {
  try {
    const { mac, ip } = req.body;
    if (!mac) {
      return res.status(400).json({ success: false, error: 'MAC address required' });
    }

    await wakeOnLan(mac);
    res.json({ success: true, message: `Wake-on-LAN sent to ${mac}${ip ? ` (${ip})` : ''}` });
  } catch (err) {
    console.error('WoL error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ WAKE ============

router.post('/wake', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    try {
      await execLocal('playactor', ['wake', '--address', ip]);
      res.json({ success: true, message: `Wake sent via playactor to ${ip}` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  } catch (err) {
    console.error('Wake error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ LAUNCH ============

router.post('/launch', async (req, res) => {
  try {
    const { ip, titleId, name } = req.body;
    if (!ip || !titleId) {
      return res.status(400).json({ success: false, error: 'IP and titleId required' });
    }

    try {
      await execLocal('playactor', ['launch', '--address', ip, '--title', titleId]);
      res.json({ success: true, message: `Launched ${name || titleId} on ${ip}` });
    } catch (err) {
      console.error('Launch error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  } catch (err) {
    console.error('Launch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ INPUT ============

router.post('/input', async (req, res) => {
  try {
    const { ip, button } = req.body;
    if (!ip || !button) {
      return res.status(400).json({ success: false, error: 'IP and button required' });
    }

    try {
      await execLocal('playactor', ['input', '--address', ip, 'press', button]);
      res.json({ success: true, message: `Input ${button} sent to ${ip}` });
    } catch (err) {
      console.error('Input error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  } catch (err) {
    console.error('Input error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ STATUS ============

router.get('/status', async (req, res) => {
  try {
    const { ip } = req.query;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    try {
      const output = await execLocal('playactor', ['status', '--address', ip]);
      const isRunning = output.toLowerCase().includes('running');
      const isStandby = output.toLowerCase().includes('standby');

      res.json({
        success: true,
        ip,
        status: isRunning ? 'running' : isStandby ? 'standby' : 'off'
      });
    } catch (err) {
      res.json({ success: false, ip, error: err.message, status: 'unreachable' });
    }
  } catch (err) {
    console.error('Status error:', err);
    res.json({ success: false, ip: req.query.ip, error: err.message, status: 'unreachable' });
  }
});

// ============ PAIRING (Pure Python) ============

router.get('/pairstatus', async (req, res) => {
  try {
    const { ip } = req.query;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    // Check if session file exists
    try {
      const sessionFile = `/app/data/chiaki_session_${ip.replace(/\./g, '_')}.json`;
      const { existsSync } = await import('fs');
      const paired = existsSync(sessionFile);

      res.json({
        success: true,
        ip,
        paired,
        message: paired ? 'PS5 is paired' : 'PS5 not paired'
      });
    } catch {
      res.json({ success: true, ip, paired: false });
    }
  } catch (err) {
    res.json({ success: false, ip: req.query.ip, paired: false, error: err.message });
  }
});

router.post('/pair/init', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    // Run Python pairing init
    const result = await new Promise((resolve, reject) => {
      const pythonCode = `
import sys
sys.path.insert(0, '/app/src/services')
from chiaki_proto import PS5Discovery

disc = PS5Discovery()
devices = disc.discover(timeout=3)

ps5_found = False
for d in devices:
    if d['ip'] == '${ip}':
        ps5_found = True
        break

if not ps5_found:
    # Try to connect directly anyway
    print('{"success": true, "ps5Found": false, "ip": "${ip}", "message": "PS5 found but not in pairing mode. Go to Settings > Accessories > Remote Play > Add Device on PS5"}')
else:
    print('{"success": true, "ps5Found": true, "ip": "${ip}", "message": "PS5 discovered. Enter PIN shown on PS5 screen"}')
`;

      exec(`python3 -c "${pythonCode.replace(/\n/g, ' ')}"`, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ success: true, message: stdout });
        }
      });
    });

    if (result.success) {
      res.json({
        success: true,
        ip,
        ps5Found: result.ps5Found,
        message: result.message
      });
    } else {
      res.status(400).json({ success: false, error: result.error || 'Failed to connect to PS5' });
    }
  } catch (err) {
    console.error('Pair init error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pair/confirm', async (req, res) => {
  try {
    const { ip, pin } = req.body;
    if (!ip || !pin) {
      return res.status(400).json({ success: false, error: 'IP and PIN required' });
    }

    // Run Python pairing confirm
    const result = await new Promise((resolve, reject) => {
      const pythonCode = `
import sys
import json
sys.path.insert(0, '/app/src/services')
from chiaki_proto import PS5Pairing

pairing = PS5Pairing('${ip}')
result = pairing.confirm_pin('${pin}')
print(json.dumps(result))
`;

      exec(`python3 -c "${pythonCode.replace(/\n/g, ' ')}"`, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Failed to parse pairing response'));
        }
      });
    });

    if (result.success) {
      // Save session file
      const { existsSync, mkdirSync, writeFileSync } = await import('fs');
      const dataDir = '/app/data';
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }
      const sessionFile = `${dataDir}/chiaki_session_${ip.replace(/\./g, '_')}.json`;
      writeFileSync(sessionFile, JSON.stringify({
        ip,
        paired: true,
        timestamp: new Date().toISOString()
      }));

      res.json({
        success: true,
        message: result.message || 'PS5 paired successfully!'
      });
    } else {
      res.status(400).json({ success: false, error: result.error || 'Invalid PIN' });
    }
  } catch (err) {
    console.error('Pair confirm error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;