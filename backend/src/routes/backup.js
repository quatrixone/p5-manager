import express from 'express';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const db = getDatabase();

    const profiles = [];
    const profileStmt = db.prepare('SELECT * FROM profiles');
    while (profileStmt.step()) {
      profiles.push(profileStmt.getAsObject());
    }
    profileStmt.free();

    const payloads = [];
    const payloadStmt = db.prepare('SELECT id, name, filename, source_url, version, size FROM payloads');
    while (payloadStmt.step()) {
      payloads.push(payloadStmt.getAsObject());
    }
    payloadStmt.free();

    const sequences = [];
    const seqStmt = db.prepare('SELECT * FROM autoload_sequences');
    while (seqStmt.step()) {
      sequences.push(seqStmt.getAsObject());
    }
    seqStmt.free();

    const settings = [];
    const settingsStmt = db.prepare('SELECT * FROM settings');
    while (settingsStmt.step()) {
      settings.push(settingsStmt.getAsObject());
    }
    settingsStmt.free();

    const backup = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: {
        profiles,
        payloads,
        sequences,
        settings
      }
    };

    log('info', 'Backup exported');

    res.json(backup);
  } catch (error) {
    log('error', `Backup export failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { data } = req.body;

    if (!data || !data.profiles) {
      return res.status(400).json({ error: 'Invalid backup data' });
    }

    const db = getDatabase();

    db.run('DELETE FROM profiles');
    for (const profile of data.profiles) {
      db.run(
        'INSERT INTO profiles (name, ip_address, mac_address, port, is_default) VALUES (?, ?, ?, ?, ?)',
        [profile.name, profile.ip_address, profile.mac_address, profile.port || 9021, profile.is_default || 0]
      );
    }

    if (data.sequences) {
      db.run('DELETE FROM autoload_sequences');
      for (const seq of data.sequences) {
        db.run(
          'INSERT INTO autoload_sequences (profile_id, name, steps, schedule_cron, schedule_enabled) VALUES (?, ?, ?, ?, ?)',
          [seq.profile_id, seq.name, seq.steps, seq.schedule_cron, seq.schedule_enabled || 0]
        );
      }
    }

    if (data.settings) {
      db.run('DELETE FROM settings');
      for (const setting of data.settings) {
        db.run(
          'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
          [setting.key, setting.value]
        );
      }
    }

    saveDatabase();
    log('info', 'Backup imported');

    res.json({ success: true, message: 'Backup restored successfully' });
  } catch (error) {
    log('error', `Backup import failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;