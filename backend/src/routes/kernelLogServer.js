import express from 'express';
import net from 'net';
import { log } from '../db/sqlite.js';

const router = express.Router();

let kernelServer = null;
let kernelPort = 3232;
let clients = [];
let receivedLogs = [];
let ps5Connection = null;
let ps5Ip = null;

function startKernelLogServer(port = 3232) {
  if (kernelServer) {
    kernelServer.close();
  }

  kernelPort = port;
  clients = [];
  receivedLogs = [];

  kernelServer = net.createServer((socket) => {
    const clientIp = socket.remoteAddress;
    clients.push(socket);
    log('info', `Kernel log client connected from ${clientIp}`);

    socket.on('data', (data) => {
      const timestamp = new Date().toISOString();
      const message = data.toString().trim();

      if (message) {
        const logEntry = { timestamp, message, ip: clientIp };
        receivedLogs.unshift(logEntry);

        if (receivedLogs.length > 500) {
          receivedLogs = receivedLogs.slice(0, 500);
        }

        console.log(`[KERNEL] ${message}`);
      }
    });

    socket.on('close', () => {
      clients = clients.filter(c => c !== socket);
      log('info', `Kernel log client disconnected from ${clientIp}`);
    });

    socket.on('error', (err) => {
      clients = clients.filter(c => c !== socket);
    });
  });

  kernelServer.on('error', (err) => {
    log('error', `Kernel log server error: ${err.message}`);
  });

  kernelServer.on('listening', () => {
    log('info', `Kernel log server started on port ${port}`);
  });

  kernelServer.listen(port, '0.0.0.0');
  return true;
}

function stopKernelLogServer() {
  clients.forEach(socket => socket.destroy());
  clients = [];
  if (kernelServer) {
    kernelServer.close();
    kernelServer = null;
    log('info', 'Kernel log server stopped');
  }
  return true;
}

function connectToPs5(ip, port = 3232) {
  return new Promise((resolve, reject) => {
    if (ps5Connection) {
      ps5Connection.destroy();
    }

    ps5Ip = ip;
    ps5Connection = new net.Socket();

    ps5Connection.connect(port, ip, () => {
      log('info', `Connected to PS5 kernel log at ${ip}:${port}`);
      resolve(true);
    });

    ps5Connection.on('data', (data) => {
      const timestamp = new Date().toISOString();
      const message = data.toString().trim();

      if (message) {
        const logEntry = { timestamp, message, ip: ip };
        receivedLogs.unshift(logEntry);

        if (receivedLogs.length > 500) {
          receivedLogs = receivedLogs.slice(0, 500);
        }

        console.log(`[KERNEL] ${message}`);
      }
    });

    ps5Connection.on('close', () => {
      log('info', `PS5 kernel log connection closed`);
      ps5Connection = null;
      ps5Ip = null;
    });

    ps5Connection.on('error', (err) => {
      log('error', `PS5 kernel log connection error: ${err.message}`);
      ps5Connection = null;
      ps5Ip = null;
      reject(err);
    });

    ps5Connection.setTimeout(10000, () => {
      ps5Connection.destroy();
      ps5Connection = null;
      ps5Ip = null;
      reject(new Error('Connection timeout'));
    });
  });
}

function disconnectFromPs5() {
  if (ps5Connection) {
    ps5Connection.destroy();
    ps5Connection = null;
    ps5Ip = null;
    log('info', 'Disconnected from PS5 kernel log');
  }
  return true;
}

router.get('/status', (req, res) => {
  res.json({
    running: kernelServer !== null || ps5Connection !== null,
    port: kernelPort,
    clients: clients.length,
    ps5Connected: ps5Connection !== null,
    ps5Ip: ps5Ip,
    logs: receivedLogs.slice(0, 100)
  });
});

router.post('/connect', async (req, res) => {
  try {
    const { ip, port } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'PS5 IP required' });
    }
    await connectToPs5(ip, port || 3232);
    res.json({ success: true, ip: ip, port: port || 3232 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/disconnect', (req, res) => {
  try {
    disconnectFromPs5();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/start', (req, res) => {
  try {
    const { port } = req.body;
    startKernelLogServer(port || kernelPort);
    res.json({ success: true, port: kernelPort });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/stop', (req, res) => {
  try {
    stopKernelLogServer();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/logs', (req, res) => {
  res.json(receivedLogs.slice(0, 100));
});

export { startKernelLogServer, stopKernelLogServer };
export default router;