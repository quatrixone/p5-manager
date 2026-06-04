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
    const ports = [9021, 9020, 8080, 6970]; // Common ports for payloads (elf/lua)

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
    const isReachable = !!openPort;

    res.json({
      ip,
      reachable: isReachable,
      openPort: openPort ? openPort.port : null,
      portsChecked: ports,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log('error', `PS5 status check failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;