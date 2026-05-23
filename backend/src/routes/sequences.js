import express from 'express';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const router = express.Router();

// Get all sequences
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT s.*, p.name as profile_name, p.ip_address
      FROM autoload_sequences s
      LEFT JOIN profiles p ON s.profile_id = p.id
      ORDER BY s.created_at DESC
    `);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(results);
  } catch (error) {
    log('error', `Failed to get sequences: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get single sequence
router.get('/:id', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM autoload_sequences WHERE id = ?');
    stmt.bind([parseInt(req.params.id)]);
    let sequence = null;
    if (stmt.step()) {
      sequence = stmt.getAsObject();
    }
    stmt.free();
    if (!sequence) {
      return res.status(404).json({ error: 'Sequence not found' });
    }
    res.json(sequence);
  } catch (error) {
    log('error', `Failed to get sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Create sequence
router.post('/', (req, res) => {
  try {
    const { profileId, name, steps, scheduleCron, scheduleEnabled } = req.body;
    if (!profileId || !name || !steps) {
      return res.status(400).json({ error: 'profileId, name, and steps required' });
    }

    const db = getDatabase();
    db.run(
      'INSERT INTO autoload_sequences (profile_id, name, steps, schedule_cron, schedule_enabled) VALUES (?, ?, ?, ?, ?)',
      [parseInt(profileId), name, JSON.stringify(steps), scheduleCron || null, scheduleEnabled ? 1 : 0]
    );
    const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    saveDatabase();

    log('info', `Created sequence: ${name}`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to create sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update sequence
router.put('/:id', (req, res) => {
  try {
    const { name, steps, scheduleCron, scheduleEnabled, profileId } = req.body;
    const db = getDatabase();

    const existing = db.prepare('SELECT id FROM autoload_sequences WHERE id = ?');
    existing.bind([parseInt(req.params.id)]);
    if (!existing.step()) {
      existing.free();
      return res.status(404).json({ error: 'Sequence not found' });
    }
    existing.free();

    db.run(
      'UPDATE autoload_sequences SET name = ?, steps = ?, profile_id = ?, schedule_cron = ?, schedule_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, JSON.stringify(steps), parseInt(profileId), scheduleCron || null, scheduleEnabled ? 1 : 0, parseInt(req.params.id)]
    );
    saveDatabase();

    log('info', `Updated sequence: ${name}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete sequence
router.delete('/:id', (req, res) => {
  try {
    const db = getDatabase();
    db.run('DELETE FROM autoload_sequences WHERE id = ?', [parseInt(req.params.id)]);
    saveDatabase();

    log('info', `Deleted sequence ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Run sequence
router.post('/:id/run', async (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT s.*, p.name as profile_name, p.ip_address, p.port
      FROM autoload_sequences s
      LEFT JOIN profiles p ON s.profile_id = p.id
      WHERE s.id = ?
    `);
    stmt.bind([parseInt(req.params.id)]);
    let sequence = null;
    if (stmt.step()) {
      sequence = stmt.getAsObject();
    }
    stmt.free();

    if (!sequence) {
      return res.status(404).json({ error: 'Sequence not found' });
    }

    const steps = JSON.parse(sequence.steps);
    log('info', `Running sequence "${sequence.name}" with ${steps.length} steps on ${sequence.ip_address}`);

    res.json({ success: true, message: `Sequence "${sequence.name}" started with ${steps.length} steps` });
  } catch (error) {
    log('error', `Failed to run sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;