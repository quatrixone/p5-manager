import { Router } from 'express';
import { spawn } from 'child_process';

const router = Router();

const execPlayActor = (args) => new Promise((resolve, reject) => {
  const proc = spawn('npx', ['playactor', ...args], { timeout: 15000 });
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (data) => { stdout += data.toString(); });
  proc.stderr.on('data', (data) => { stderr += data.toString(); });

  proc.on('close', (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr || `Exit code ${code}: ${stdout}`));
  });
  proc.on('error', reject);
});

router.post('/wake', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    await execPlayActor(['wake', '--address', ip]);
    res.json({ success: true, message: `Wake-on-LAN sent to ${ip}` });
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

    await execPlayActor(['launch', '--address', ip, '--title', titleId]);
    res.json({ success: true, message: `Launched ${name || titleId} on ${ip}` });
  } catch (err) {
    console.error('Launch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/input', async (req, res) => {
  try {
    const { ip, button } = req.body;
    if (!ip || !button) {
      return res.status(400).json({ success: false, error: 'IP and button required' });
    }

    await execPlayActor(['input', '--address', ip, 'press', button]);
    res.json({ success: true, message: `Pressed ${button} on ${ip}` });
  } catch (err) {
    console.error('Input error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const { ip } = req.query;
    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address required' });
    }

    const output = await execPlayActor(['status', '--address', ip]);
    const isRunning = output.toLowerCase().includes('running');
    const isStandby = output.toLowerCase().includes('standby');

    res.json({
      success: true,
      ip,
      running: isRunning,
      standby: isStandby,
      status: isRunning ? 'running' : isStandby ? 'standby' : 'off'
    });
  } catch (err) {
    console.error('Status error:', err);
    res.json({ success: false, ip: req.query.ip, error: err.message, status: 'unreachable' });
  }
});

export default router;