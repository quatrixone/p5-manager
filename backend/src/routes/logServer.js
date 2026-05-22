import express from 'express';
import dgram from 'dgram';
import { log } from '../db/sqlite.js';

const router = express.Router();

let logServer = null;
let logServerPort = 8080;
let receivedLogs = [];

function startLogServer(port = 8080) {
  if (logServer) {
    logServer.close();
  }

  logServerPort = port;
  logServer = dgram.createSocket('udp4');
  receivedLogs = [];

  logServer.on('error', (err) => {
    log('error', `Log server error: ${err.message}`);
    logServer.close();
    logServer = null;
  });

  logServer.on('message', (msg, rinfo) => {
    const timestamp = new Date().toISOString();
    const message = msg.toString().trim();
    receivedLogs.unshift({
      timestamp,
      message,
      ip: rinfo.address
    });
    // Keep only last 500 logs
    if (receivedLogs.length > 500) {
      receivedLogs = receivedLogs.slice(0, 500);
    }
    console.log(`[LOG] ${message}`);
  });

  logServer.on('listening', () => {
    log('info', `Log server started on port ${port}`);
  });

  logServer.bind(port);
  return true;
}

function stopLogServer() {
  if (logServer) {
    logServer.close();
    logServer = null;
    log('info', 'Log server stopped');
  }
  return true;
}

router.get('/status', (req, res) => {
  res.json({
    running: logServer !== null,
    port: logServerPort,
    logs: receivedLogs.slice(0, 100)
  });
});

router.post('/start', (req, res) => {
  try {
    const { port } = req.body;
    const portToUse = port || logServerPort;
    startLogServer(portToUse);
    res.json({ success: true, port: portToUse });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/stop', (req, res) => {
  try {
    stopLogServer();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/logs', (req, res) => {
  res.json(receivedLogs.slice(0, 100));
});

export { startLogServer, stopLogServer };
export default router;