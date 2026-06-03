import express from 'express';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const router = express.Router();

// Get all scripts
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM input_scripts ORDER BY created_at DESC');
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(results);
  } catch (error) {
    log('error', `Failed to get input scripts: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get single script
router.get('/:id', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM input_scripts WHERE id = ?');
    stmt.bind([parseInt(req.params.id)]);
    let script = null;
    if (stmt.step()) {
      script = stmt.getAsObject();
    }
    stmt.free();
    if (!script) {
      return res.status(404).json({ error: 'Script not found' });
    }
    res.json(script);
  } catch (error) {
    log('error', `Failed to get input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Create script
router.post('/', (req, res) => {
  try {
    const { name, script } = req.body;
    if (!name || !script) {
      return res.status(400).json({ error: 'name and script required' });
    }

    const db = getDatabase();
    db.run(
      'INSERT INTO input_scripts (name, script) VALUES (?, ?)',
      [name, script]
    );
    const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    saveDatabase();

    log('info', `Created input script: ${name}`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to create input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update script
router.put('/:id', (req, res) => {
  try {
    const { name, script } = req.body;
    if (!name || !script) {
      return res.status(400).json({ error: 'name and script required' });
    }

    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM input_scripts WHERE id = ?');
    existing.bind([parseInt(req.params.id)]);
    if (!existing.step()) {
      existing.free();
      return res.status(404).json({ error: 'Script not found' });
    }
    existing.free();

    db.run(
      'UPDATE input_scripts SET name = ?, script = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, script, parseInt(req.params.id)]
    );
    saveDatabase();

    log('info', `Updated input script: ${name}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete script
router.delete('/:id', (req, res) => {
  try {
    const db = getDatabase();
    db.run('DELETE FROM input_scripts WHERE id = ?', [parseInt(req.params.id)]);
    saveDatabase();

    log('info', `Deleted input script ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;