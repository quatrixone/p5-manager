import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../../data');
const payloadsDir = path.join(dataDir, 'payloads');

const router = express.Router();

function ensurePayloadsDir() {
  if (!fs.existsSync(payloadsDir)) {
    fs.mkdirSync(payloadsDir, { recursive: true });
  }
}

router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const results = [];
    const stmt = db.prepare('SELECT * FROM payloads ORDER BY created_at DESC');
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(results);
  } catch (error) {
    log('error', `Failed to get payloads: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/fetch', async (req, res) => {
  try {
    const { repo, filePath } = req.body;

    if (!repo) {
      return res.status(400).json({ error: 'Repository URL required' });
    }

    log('info', `Fetching payloads from: ${repo}`);

    const apiUrl = repo.replace('github.com', 'api.github.com/repos');
    const response = await fetch(`${apiUrl}/contents/${filePath || ''}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const contents = await response.json();
    const items = Array.isArray(contents) ? contents : [contents];

    ensurePayloadsDir();

    const db = getDatabase();
    const results = [];

    for (const item of items) {
      if (item.name.endsWith('.bin') || item.name.endsWith('.zip')) {
        const downloadUrl = item.download_url;
        const fileResponse = await fetch(downloadUrl);
        const buffer = await fileResponse.buffer();

        const filename = item.name;
        const filepath = path.join(payloadsDir, filename);

        fs.writeFileSync(filepath, buffer);

        db.run(
          'INSERT INTO payloads (name, filename, filepath, source_url, size) VALUES (?, ?, ?, ?, ?)',
          [item.name, filename, filepath, downloadUrl, buffer.length]
        );

        const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];

        results.push({
          id: lastId,
          name: item.name,
          size: buffer.length
        });

        log('info', `Downloaded: ${item.name}`);
      }
    }

    saveDatabase();
    res.json({ success: true, downloaded: results });
  } catch (error) {
    log('error', `Fetch failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/upload', (req, res) => {
  try {
    const { name, data } = req.body;

    if (!name || !data) {
      return res.status(400).json({ error: 'Name and data required' });
    }

    ensurePayloadsDir();

    const buffer = Buffer.from(data, 'base64');
    const filepath = path.join(payloadsDir, name);

    fs.writeFileSync(filepath, buffer);

    const db = getDatabase();
    db.run(
      'INSERT INTO payloads (name, filename, filepath, size) VALUES (?, ?, ?, ?)',
      [name, name, filepath, buffer.length]
    );

    const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    saveDatabase();

    log('info', `Uploaded payload: ${name}`);

    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Upload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/send/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { ip, port } = req.body;

    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM payloads WHERE id = ?');
    stmt.bind([parseInt(id)]);
    let payload = null;
    if (stmt.step()) {
      payload = stmt.getAsObject();
    }
    stmt.free();

    if (!payload) {
      return res.status(404).json({ error: 'Payload not found' });
    }

    if (!fs.existsSync(payload.filepath)) {
      return res.status(404).json({ error: 'Payload file not found on disk' });
    }

    const fileData = fs.readFileSync(payload.filepath);

    log('info', `Sending ${payload.name} to ${ip}:${port || 9021}`);

    const targetPort = port || 9021;

    const net = await import('net');
    const client = new net.Socket();

    await new Promise((resolve, reject) => {
      client.connect(targetPort, ip, () => {
        client.write(fileData, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      client.on('error', reject);
      client.setTimeout(10000);
    });

    client.end();
    client.destroy();

    log('info', `Payload ${payload.name} sent successfully`);

    res.json({ success: true, message: `Sent to ${ip}:${targetPort}` });
  } catch (error) {
    log('error', `Send failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM payloads WHERE id = ?');
    stmt.bind([parseInt(id)]);
    let payload = null;
    if (stmt.step()) {
      payload = stmt.getAsObject();
    }
    stmt.free();

    if (payload && fs.existsSync(payload.filepath)) {
      fs.unlinkSync(payload.filepath);
    }

    db.run('DELETE FROM payloads WHERE id = ?', [parseInt(id)]);
    saveDatabase();

    log('info', `Deleted payload ID: ${id}`);

    res.json({ success: true });
  } catch (error) {
    log('error', `Delete failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;