import express from 'express';
import { getRepo, log } from '../db/sqlite.js';
import { readMarketplaceBuiltinList, writeMarketplaceBuiltinList } from '../lib/marketplaceCatalog.js';

const router = express.Router();

const BUILTIN_FILE = 'inputScripts.json';

// Legacy builtin:* ids remain stable for existing Autoload sequences.
export async function readBuiltinInputScripts(options) {
  return readMarketplaceBuiltinList(BUILTIN_FILE, options);
}
router.get('/builtin', async (req, res) => {
  try {
    const list = await readBuiltinInputScripts({ refresh: req.query.refresh === '1' });
    res.json(list.filter(s => !req.query.console_type || !s.console_type || s.console_type === req.query.console_type));
  } catch (err) {
    log('error', `Marketplace scripts: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    res.json(getRepo().queryAll('SELECT * FROM input_scripts ORDER BY created_at DESC'));
  } catch (error) {
    log('error', `Failed to get input scripts: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const script = getRepo().queryOne('SELECT * FROM input_scripts WHERE id = ?', [parseInt(req.params.id)]);
    if (!script) return res.status(404).json({ error: 'Script not found' });
    res.json(script);
  } catch (error) {
    log('error', `Failed to get input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, script } = req.body;
    if (!name || !script) return res.status(400).json({ error: 'name and script required' });
    const lastId = getRepo().runAndSave(
      'INSERT INTO input_scripts (name, script) VALUES (?, ?)',
      [name, script],
    );
    log('info', `Created input script: ${name}`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to create input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { name, script } = req.body;
    if (!name || !script) return res.status(400).json({ error: 'name and script required' });
    const repo = getRepo();
    if (!repo.queryOne('SELECT id FROM input_scripts WHERE id = ?', [parseInt(req.params.id)])) {
      return res.status(404).json({ error: 'Script not found' });
    }
    repo.runAndSave(
      'UPDATE input_scripts SET name = ?, script = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, script, parseInt(req.params.id)],
    );
    log('info', `Updated input script: ${name}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    getRepo().runAndSave('DELETE FROM input_scripts WHERE id = ?', [parseInt(req.params.id)]);
    log('info', `Deleted input script ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Edits are persistent local overrides; marketplace refreshes retain them.
router.put('/builtin/:id', async (req, res) => {
  try {
    const { script } = req.body || {};
    if (typeof script !== 'string' || script.length > 20000) return res.status(400).json({ error: 'script must be text, at most 20000 characters' });
    const entries = await readBuiltinInputScripts();
    const entry = entries.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Marketplace script not found' });
    entry.script = script;
    await writeMarketplaceBuiltinList(BUILTIN_FILE, entries);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

export default router;
