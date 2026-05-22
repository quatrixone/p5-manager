import express from 'express';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const results = [];
    const stmt = db.prepare('SELECT * FROM profiles ORDER BY name');
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(results);
  } catch (error) {
    log('error', `Failed to get profiles: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM profiles WHERE id = ?');
    stmt.bind([parseInt(req.params.id)]);
    let profile = null;
    if (stmt.step()) {
      profile = stmt.getAsObject();
    }
    stmt.free();

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(profile);
  } catch (error) {
    log('error', `Failed to get profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, ip_address, port } = req.body;

    if (!name || !ip_address) {
      return res.status(400).json({ error: 'Name and IP address required' });
    }

    const db = getDatabase();
    db.run(
      'INSERT INTO profiles (name, ip_address, port) VALUES (?, ?, ?)',
      [name, ip_address, port || 9021]
    );

    const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    saveDatabase();

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
    const { name, ip_address, port } = req.body;

    const db = getDatabase();

    const selectStmt = db.prepare('SELECT * FROM profiles WHERE id = ?');
    selectStmt.bind([parseInt(id)]);
    let existing = null;
    if (selectStmt.step()) {
      existing = selectStmt.getAsObject();
    }
    selectStmt.free();

    if (!existing) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    db.run(
      'UPDATE profiles SET name = ?, ip_address = ?, port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name || existing.name, ip_address || existing.ip_address, port || existing.port, parseInt(id)]
    );

    saveDatabase();
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

    const db = getDatabase();
    db.run('DELETE FROM profiles WHERE id = ?', [parseInt(id)]);
    saveDatabase();

    log('info', `Deleted profile: ${id}`);

    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete profile: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/autoload', async (req, res) => {
  try {
    const { id } = req.params;
    const { sequence } = req.body;

    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM profiles WHERE id = ?');
    stmt.bind([parseInt(id)]);
    let profile = null;
    if (stmt.step()) {
      profile = stmt.getAsObject();
    }
    stmt.free();

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    log('info', `Starting autoload sequence for ${profile.name}`);

    res.json({ success: true, message: 'Autoload started', profile: profile.name });
  } catch (error) {
    log('error', `Autoload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;