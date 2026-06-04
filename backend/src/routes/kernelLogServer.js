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

function connectToPs5Once(ip, port = 3232) {
  return new Promise((resolve, reject) => {
    if (ps5Connection) {
      try { ps5Connection.destroy(); } catch (_) {}
    }

    ps5Ip = ip;
    const sock = new net.Socket();
    ps5Connection = sock;
    let settled = false;

    // Bounded *connect* timeout - cleared once the TCP handshake succeeds.
    // We deliberately do NOT use socket.setTimeout because that's an idle
    // timeout that would kill working connections when kernel logs are quiet.
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      if (ps5Connection === sock) { ps5Connection = null; ps5Ip = null; }
      reject(new Error(`connect timeout (${ip}:${port})`));
    }, 5000);

    sock.connect(port, ip, () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      log('info', `Connected to PS5 kernel log at ${ip}:${port}`);
      resolve(true);
    });

    sock.on('data', (data) => {
      const timestamp = new Date().toISOString();
      const message = data.toString().trim();
      if (!message) return;
      receivedLogs.unshift({ timestamp, message, ip });
      if (receivedLogs.length > 500) receivedLogs = receivedLogs.slice(0, 500);
      console.log(`[KERNEL] ${message}`);
    });

    sock.on('close', () => {
      log('info', `PS5 kernel log connection closed`);
      if (ps5Connection === sock) { ps5Connection = null; ps5Ip = null; }
    });

    sock.on('error', (err) => {
      if (settled) {
        // Already running - just log; auto-reconnect can happen at a higher
        // layer. Don't reject (the original Promise has resolved).
        log('warn', `PS5 kernel log socket error: ${err.message}`);
        return;
      }
      settled = true;
      clearTimeout(connectTimer);
      if (ps5Connection === sock) { ps5Connection = null; ps5Ip = null; }
      reject(err);
    });
  });
}

// Wraps the single-shot connect with bounded retries so we tolerate klogsrv
// still booting up after the elfldr send completes (typically takes 1-3 s).
async function connectToPs5(ip, port = 3232, maxAttempts = 6) {
  let lastErr;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await connectToPs5Once(ip, port);
    } catch (err) {
      lastErr = err;
      log('info', `Kernel log connect attempt ${i}/${maxAttempts} failed: ${err.message}`);
      if (i < maxAttempts) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr || new Error('kernel log connect failed');
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

// Internal helper used by other routes (e.g. payload send) to inject lines
// into the kernel-log feed so any output streamed by a payload back over the
// elfldr socket shows up in the same Logs panel the user is already watching.
function pushKernelLogEntry(message, ip = null, tag = null) {
  if (!message) return;
  const trimmed = String(message);
  const timestamp = new Date().toISOString();
  // Split on newlines so each line becomes its own entry (matches what
  // klogsrv produces) and prefix with the tag in square brackets.
  const lines = trimmed.split(/\r?\n/).filter(l => l.length > 0);
  for (const line of lines) {
    const entry = {
      timestamp,
      message: tag ? `[${tag}] ${line}` : line,
      ip: ip || 'payload',
    };
    receivedLogs.unshift(entry);
    if (receivedLogs.length > 500) receivedLogs = receivedLogs.slice(0, 500);
    console.log(`[KERNEL]${tag ? ` [${tag}]` : ''} ${line}`);
  }
}

export { startKernelLogServer, stopKernelLogServer, pushKernelLogEntry };
export default router;