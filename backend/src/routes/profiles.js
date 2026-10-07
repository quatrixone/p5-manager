import express from 'express';
import { getRepo, log } from '../db/sqlite.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    res.json(getRepo().queryAll('SELECT * FROM profiles ORDER BY name'));
  } catch (error) {
    log('error', `Failed to get profiles: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const profile = getRepo().queryOne('SELECT * FROM profiles WHERE id = ?', [parseInt(req.params.id)]);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
  } catch (error) {
    log('error', `Failed to get profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/default', (req, res) => {
  try {
    const repo = getRepo();
    const profile = repo.queryOne('SELECT * FROM profiles WHERE is_default = 1 LIMIT 1')
      || repo.queryOne('SELECT * FROM profiles ORDER BY id LIMIT 1');
    res.json(profile || { error: 'No profile found' });
  } catch (error) {
    log('error', `Failed to get default profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Accepted values for the platform tag stored on each profile. NULL is also
// legal and means "auto-detect via the Remote Play service's /discover on next status
// poll".
const CONSOLE_TYPES = new Set(['ps4', 'ps5']);
function normalizeConsoleType(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  return CONSOLE_TYPES.has(s) ? s : null;
}

// FTP port as sent by the form: empty = NULL (follow the console type),
// a valid port = that port, anything else = false (reject).
function normalizeFtpPort(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : false;
}

// One profile per console address: Remote Play pairing, sessions and Autoload
// triggers are all looked up by IP, so two profiles on one address would get
// each other's pairing. Returns the profile already using `ip`, if any.
function profileWithIp(ip, exceptId = null) {
  return getRepo().queryOne(
    'SELECT id, name FROM profiles WHERE TRIM(ip_address) = ? AND id != ? LIMIT 1',
    [String(ip).trim(), exceptId == null ? -1 : exceptId],
  );
}

router.post('/', (req, res) => {
  try {
    const { name, mac_address, port, console_type } = req.body;
    const ip_address = String(req.body.ip_address || '').trim();
    if (!name || !ip_address) return res.status(400).json({ error: 'Name and IP address required' });
    const ftp_port = normalizeFtpPort(req.body.ftp_port);
    if (ftp_port === false) return res.status(400).json({ error: 'FTP port has to be a number between 1 and 65535' });
    const taken = profileWithIp(ip_address);
    if (taken) return res.status(409).json({ error: `Profile "${taken.name}" already uses ${ip_address}` });
    const lastId = getRepo().runAndSave(
      'INSERT INTO profiles (name, ip_address, mac_address, port, console_type, ftp_port) VALUES (?, ?, ?, ?, ?, ?)',
      [name, ip_address, mac_address || null, port || 9021, normalizeConsoleType(console_type), ftp_port],
    );
    log('info', `Created profile: ${name} (${ip_address})`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to create profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, mac_address, port, console_type } = req.body;
    const ip_address = String(req.body.ip_address || '').trim();
    const repo = getRepo();
    const existing = repo.queryOne('SELECT * FROM profiles WHERE id = ?', [parseInt(id)]);
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    const taken = ip_address ? profileWithIp(ip_address, existing.id) : null;
    if (taken) return res.status(409).json({ error: `Profile "${taken.name}" already uses ${ip_address}` });

    // ftp_port === undefined means "don't touch"; empty clears it back to the
    // default for the console type.
    const nextFtpPort = req.body.ftp_port === undefined ? existing.ftp_port : normalizeFtpPort(req.body.ftp_port);
    if (nextFtpPort === false) return res.status(400).json({ error: 'FTP port has to be a number between 1 and 65535' });

    // console_type === undefined means "don't touch"; explicit null clears
    // the field back to auto-detect, explicit 'ps4' / 'ps5' overrides.
    const nextConsoleType = console_type === undefined
      ? existing.console_type
      : normalizeConsoleType(console_type);

    repo.runAndSave(
      'UPDATE profiles SET name = ?, ip_address = ?, mac_address = ?, port = ?, console_type = ?, ftp_port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        name || existing.name,
        ip_address || existing.ip_address,
        mac_address !== undefined ? mac_address : existing.mac_address,
        port || existing.port,
        nextConsoleType,
        nextFtpPort,
        parseInt(id),
      ],
    );
    log('info', `Updated profile: ${id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    getRepo().runAndSave('DELETE FROM profiles WHERE id = ?', [parseInt(id)]);
    log('info', `Deleted profile: ${id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/set-default', (req, res) => {
  try {
    const { id } = req.params;
    const repo = getRepo();
    repo.run('UPDATE profiles SET is_default = 0');
    repo.runAndSave('UPDATE profiles SET is_default = 1 WHERE id = ?', [parseInt(id)]);
    log('info', `Set profile ${id} as default`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to set default profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/autoload', async (req, res) => {
  try {
    const { id } = req.params;
    const profile = getRepo().queryOne('SELECT * FROM profiles WHERE id = ?', [parseInt(id)]);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    log('info', `Starting autoload sequence for ${profile.name}`);
    res.json({ success: true, message: 'Autoload started', profile: profile.name });
  } catch (error) {
    log('error', `Autoload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
