import express from 'express';
import { getLogs, clearLogs } from '../db/sqlite.js';

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

router.delete('/', (req, res) => {
  try {
    clearLogs();
    res.json({ success: true, message: 'Logs cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;