import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { getRepo, log } from '../db/sqlite.js';
import { payloadsDir } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

function ensurePayloadsDir() {
  if (!fs.existsSync(payloadsDir)) {
    fs.mkdirSync(payloadsDir, { recursive: true });
  }
}

router.get('/', (req, res) => {
  try {
    ensurePayloadsDir();

    const repo = getRepo();
    const profiles = repo.queryAll('SELECT * FROM profiles');
    const payloads = repo.queryAll('SELECT id, name, filename, source_url, version, size FROM payloads');
    const sequences = repo.queryAll('SELECT * FROM autoload_sequences');
    const settings = repo.queryAll('SELECT * FROM settings');

    const backup = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: { profiles, payloads, sequences, settings },
    };

    const zip = new AdmZip();
    zip.addFile('backup.json', JSON.stringify(backup, null, 2));

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
      'Content-Length': zipBuffer.length,
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
      data = req.body.data;
    }

    if (!data || !data.profiles) {
      return res.status(400).json({ error: 'Invalid backup data' });
    }

    const repo = getRepo();
    ensurePayloadsDir();

    repo.run('DELETE FROM profiles');
    for (const profile of data.profiles) {
      repo.run(
        'INSERT INTO profiles (name, ip_address, mac_address, port, is_default) VALUES (?, ?, ?, ?, ?)',
        [profile.name, profile.ip_address, profile.mac_address, profile.port || 9021, profile.is_default || 0],
      );
    }

    if (data.sequences) {
      repo.run('DELETE FROM autoload_sequences');
      for (const seq of data.sequences) {
        repo.run(
          'INSERT INTO autoload_sequences (profile_id, name, steps, schedule_cron, schedule_enabled) VALUES (?, ?, ?, ?, ?)',
          [seq.profile_id, seq.name, seq.steps, seq.schedule_cron, seq.schedule_enabled || 0],
        );
      }
    }

    if (data.settings) {
      repo.run('DELETE FROM settings');
      for (const setting of data.settings) {
        repo.run(
          'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
          [setting.key, setting.value],
        );
      }
    }

    if (data.payloads && data.payloads.length > 0) {
      repo.run('DELETE FROM payloads');
      for (const payload of data.payloads) {
        const filepath = path.join(payloadsDir, payload.filename);

        if (payloadFiles[payload.filename]) {
          fs.writeFileSync(filepath, payloadFiles[payload.filename]);
        } else if (fs.existsSync(filepath)) {
          // File already exists, use it
        } else {
          continue;
        }

        const size = fs.existsSync(filepath) ? fs.statSync(filepath).size : payload.size;
        repo.run(
          'INSERT INTO payloads (name, filename, filepath, source_url, version, size) VALUES (?, ?, ?, ?, ?, ?)',
          [payload.name, payload.filename, filepath, payload.source_url || null, payload.version || null, size],
        );
      }
    }

    repo.save();
    log('info', 'Backup imported');

    res.json({ success: true, message: 'Backup restored successfully' });
  } catch (error) {
    log('error', `Backup import failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
