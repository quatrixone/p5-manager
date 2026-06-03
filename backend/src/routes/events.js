import express from 'express';
import crypto from 'crypto';

const router = express.Router();

const clients = new Map();

export function broadcast(event, data) {
  const payload = `data: ${JSON.stringify({ event, data, ts: Date.now() })}\n\n`;
  for (const [id, res] of clients) {
    try {
      res.write(payload);
    } catch (e) {
      clients.delete(id);
    }
  }
}

router.get('/stream', (req, res) => {
  const clientId = crypto.randomBytes(8).toString('hex');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ event: 'connected', data: { clientId }, ts: Date.now() })}\n\n`);

  clients.set(clientId, res);

  req.on('close', () => {
    clients.delete(clientId);
  });
});

router.get('/status', (req, res) => {
  res.json({ connected: clients.size });
});

export default router;