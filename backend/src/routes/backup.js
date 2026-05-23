import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../data');
const payloadsDir = path.join(dataDir, 'payloads');

const router = express.Router();

function ensurePayloadsDir() {
  if (!fs.existsSync(payloadsDir)) {
    fs.mkdirSync(payloadsDir, { recursive: true });
  }
}

router.get('/', (req, res) => {
  try {
    ensurePayloadsDir();

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

    // Create ZIP with backup data and payload files
    const zip = new AdmZip();

    // Add backup.json with all database data
    zip.addFile('backup.json', JSON.stringify(backup, null, 2));

    // Add payload files
    for (const payload of payloads) {
      if (fs.existsSync(payload.filepath)) {
        zip.addFile(path.join('payloads', payload.filename), fs.readFileSync(payload.filepath));
      }
    }

    const zipBuffer = zip.toBuffer();

    log('info', 'Backup exported');

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="backup-${new Date().toISOString().slice(0, 10)}.zip"`,
      'Content-Length': zipBuffer.length
    });
    res.send(zipBuffer);
  } catch (error) {
    log('error', `Backup export failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    let data;
    let payloadFiles = {};

    // Check if request is a ZIP file (has base64 encoded zip)
    if (req.body.zip) {
      try {
        const zipBuffer = Buffer.from(req.body.zip, 'base64');
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();

        for (const entry of zipEntries) {
          if (entry.entryName === 'backup.json') {
            data = JSON.parse(entry.getData().toString('utf8'));
          } else if (entry.entryName.startsWith('payloads/')) {
            const filename = path.basename(entry.entryName);
            payloadFiles[filename] = entry.getData();
          }
        }
      } catch (zipError) {
        return res.status(400).json({ error: `Invalid ZIP file: ${zipError.message}` });
      }
    } else if (req.body.data) {
      // Legacy JSON format
      data = req.body.data;
    }

    if (!data || !data.profiles) {
      return res.status(400).json({ error: 'Invalid backup data' });
    }

    const db = getDatabase();
    ensurePayloadsDir();

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

    // Restore payloads if included in backup
    if (data.payloads && data.payloads.length > 0) {
      db.run('DELETE FROM payloads');
      for (const payload of data.payloads) {
        const filepath = path.join(payloadsDir, payload.filename);

        // Restore payload file if it exists in the ZIP
        if (payloadFiles[payload.filename]) {
          fs.writeFileSync(filepath, payloadFiles[payload.filename]);
        } else if (fs.existsSync(filepath)) {
          // File already exists, use it
        } else {
          // Skip payload that has no file
          continue;
        }

        const size = fs.existsSync(filepath) ? fs.statSync(filepath).size : payload.size;
        db.run(
          'INSERT INTO payloads (name, filename, filepath, source_url, version, size) VALUES (?, ?, ?, ?, ?, ?)',
          [payload.name, payload.filename, filepath, payload.source_url || null, payload.version || null, size]
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