import express from 'express';
import os from 'os';
import { getLogs, clearLogs } from '../db/sqlite.js';
import { readFileLog, appVersion } from '../lib/fileLog.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = getLogs(limit);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// The log file, to save and send along with a problem report.
router.get('/file', (req, res) => {
  try {
    const head = [
      `P5 Manager ${appVersion} log, saved ${new Date().toISOString()}`,
      `platform: ${process.env.P5M_PLATFORM || 'unknown'} (${process.platform} ${os.release()}, ${process.arch}), Node ${process.version}`,
      'This file can hold addresses of your consoles and names of your files. Look through it before you post it in public.',
      '',
    ].join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="p5manager-log-${new Date().toISOString().slice(0, 10)}.txt"`);
    res.send(`${head}\n${readFileLog()}`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/', (req, res) => {
  try {
    clearLogs();
    res.json({ success: true, message: 'Logs cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;