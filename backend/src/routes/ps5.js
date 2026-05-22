import express from 'express';
import fs from 'fs';
import { log } from '../db/sqlite.js';

const router = express.Router();

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
    const port = req.query.port || 9021;

    log('info', `Checking PS5 status at ${ip}:${port}`);

    const net = await import('net');

    const isReachable = await new Promise((resolve) => {
      const client = new net.Socket();
      client.setTimeout(3000);

      client.on('connect', () => {
        client.destroy();
        resolve(true);
      });

      client.on('timeout', () => {
        client.destroy();
        resolve(false);
      });

      client.on('error', () => {
        client.destroy();
        resolve(false);
      });

      client.connect(port, ip);
    });

    res.json({
      ip,
      port,
      reachable: isReachable,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log('error', `PS5 status check failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;