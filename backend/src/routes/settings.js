import express from 'express';
import path from 'path';
import { getRepo, log, saveDatabase } from '../db/sqlite.js';
import { payloadsDir } from '../lib/paths.js';

const router = express.Router();

const DEFAULT_PAYLOADS = [
  { name: 'Payload Kernel Logger (klogsrv)', url: 'https://github.com/john-tornblom/ps5-payload-klogsrv/releases/latest/download/klogsrv.elf' },
  { name: 'BD-JB', url: 'https://github.com/ps5-payload-sdk/BD-JB/releases/latest/download/BD-JB.elf' },
  { name: 'Enable UART', url: 'https://github.com/ps5-payload-sdk/uart-enable/releases/latest/download/uart-enable.elf' },
];

router.get('/', (req, res) => {
  try {
    const rows = getRepo().queryAll('SELECT key, value FROM settings');
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (!settings.default_payloads) settings.default_payloads = JSON.stringify(DEFAULT_PAYLOADS);
    res.json(settings);
  } catch (error) {
    log('error', `Failed to get settings: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.put('/', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });
    getRepo().runAndSave(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      [key, typeof value === 'object' ? JSON.stringify(value) : value],
    );
    log('info', `Updated setting: ${key}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update setting: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Exits the process and relies on the container restart policy
// (docker-compose: `restart: unless-stopped`) to bring it back. Emitting
// SIGTERM first runs the same listeners `docker stop` would trigger
// (convert.js snapshots the queue state there).
router.post('/restart', (req, res) => {
  log('info', 'Restart requested from Settings');
  res.json({ success: true });
  setTimeout(() => {
    try { process.emit('SIGTERM'); } catch (_) {}
    try { saveDatabase(); } catch (_) {}
    process.exit(0);
  }, 300);
});

router.get('/payloads', (req, res) => {
  try {
    res.json(getRepo().queryAll('SELECT * FROM payloads ORDER BY name'));
  } catch (error) {
    log('error', `Failed to get payloads: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/payloads', async (req, res) => {
  try {
    const { name, source_url } = req.body;
    if (!name || !source_url) return res.status(400).json({ error: 'Name and source_url required' });
    const lastId = getRepo().runAndSave(
      'INSERT INTO payloads (name, filename, filepath, source_url) VALUES (?, ?, ?, ?)',
      [name, `${name}.elf`, path.join(payloadsDir, `${name}.elf`), source_url],
    );
    log('info', `Added payload: ${name} from ${source_url}`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to add payload: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/payloads/:id', (req, res) => {
  try {
    const { id } = req.params;
    getRepo().runAndSave('DELETE FROM payloads WHERE id = ?', [parseInt(id)]);
    log('info', `Deleted payload: ${id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete payload: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
