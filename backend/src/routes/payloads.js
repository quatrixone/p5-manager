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

router.post('/fetch-url', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL required' });
    }

    ensurePayloadsDir();

    // Check if it's a releases URL
    const releasesMatch = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/releases(?:\/tag\/([^\/\?#]+))?/i);
    if (releasesMatch) {
      const [, owner, repo, tag] = releasesMatch;
      log('info', `Fetching releases: ${owner}/${repo} (tag: ${tag || 'latest'})`);

      const apiUrl = tag
        ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
        : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

      const response = await fetch(apiUrl, { headers: { 'Accept': 'application/vnd.github.v3+json' } });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const release = await response.json();
      const results = [];
      const db = getDatabase();
      const version = release.tag_name || 'latest';

      for (const asset of release.assets) {
        const name = asset.name.toLowerCase();
        const isLuaOrElf = name.endsWith('.lua') || name.endsWith('.elf');
        const isZip = name.endsWith('.zip');

        if (isLuaOrElf || isZip) {
          const downloadUrl = asset.browser_download_url;
          const fileResponse = await fetch(downloadUrl);
          const buffer = await fileResponse.arrayBuffer().then(ab => Buffer.from(ab));

          if (isZip) {
            try {
              const zip = new AdmZip(buffer);
              const zipEntries = zip.getEntries();

              for (const entry of zipEntries) {
                const entryName = entry.entryName.toLowerCase();
                if (entryName.endsWith('.lua') || entryName.endsWith('.elf')) {
                  const entryBuffer = entry.getData();
                  const baseName = entry.entryName.replace(/\.(lua|elf)$/i, '');
                  const ext = entry.entryName.match(/\.(lua|elf)$/i)[0];
                  const filenameWithVersion = `${baseName}-${version}${ext}`;
                  const filepath = path.join(payloadsDir, filenameWithVersion);

                  fs.writeFileSync(filepath, entryBuffer);
                  db.run(
                    'INSERT INTO payloads (name, filename, filepath, source_url, size, version) VALUES (?, ?, ?, ?, ?, ?)',
                    [filenameWithVersion, filenameWithVersion, filepath, downloadUrl, entryBuffer.length, version]
                  );
                  const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
                  results.push({ id: lastId, name: filenameWithVersion, size: entryBuffer.length, version });
                  log('info', `Extracted from ZIP ${version}: ${entry.entryName}`);
                }
              }
            } catch (zipError) {
              log('error', `Failed to extract ZIP ${asset.name}: ${zipError.message}`);
            }
          } else {
            const baseName = asset.name.replace(/\.(lua|elf)$/i, '');
            const ext = asset.name.match(/\.(lua|elf)$/i)[0];
            const filenameWithVersion = `${baseName}-${version}${ext}`;
            const filepath = path.join(payloadsDir, filenameWithVersion);

            fs.writeFileSync(filepath, buffer);
            db.run(
              'INSERT INTO payloads (name, filename, filepath, source_url, size, version) VALUES (?, ?, ?, ?, ?, ?)',
              [filenameWithVersion, filenameWithVersion, filepath, downloadUrl, buffer.length, version]
            );
            const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
            results.push({ id: lastId, name: filenameWithVersion, size: buffer.length, version });
            log('info', `Downloaded from release ${version}: ${asset.name}`);
          }
        }
      }

      saveDatabase();
      if (results.length === 0) {
        return res.json({ success: true, downloaded: [], message: 'No .lua or .elf files found in release' });
      }
      return res.json({ success: true, downloaded: results });
    }

    // Check if it's a direct blob URL - convert to raw
    const blobMatch = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\s?#]+)/i);
    if (blobMatch) {
      const [, owner, repo, filePath] = blobMatch;
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${filePath}`;
      log('info', `Fetching raw: ${rawUrl}`);

      const response = await fetch(rawUrl, {
        headers: { 'Accept': 'application/octet-stream' },
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer().then(ab => Buffer.from(ab));
      const filename = filePath.split('/').pop();

      if (!buffer.length) {
        throw new Error('Downloaded file is empty');
      }

      if (filename.endsWith('.lua') || filename.endsWith('.elf')) {
        const filepath = path.join(payloadsDir, filename);
        fs.writeFileSync(filepath, buffer);

        const db = getDatabase();
        db.run(
          'INSERT INTO payloads (name, filename, filepath, source_url, size) VALUES (?, ?, ?, ?, ?)',
          [filename, filename, filepath, url, buffer.length]
        );
        const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        saveDatabase();

        log('info', `Downloaded: ${filename} (${buffer.length} bytes)`);
        return res.json({ success: true, downloaded: [{ id: lastId, name: filename, size: buffer.length }] });
      }
    }

    // Check for raw URL
    const rawMatch = url.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/\?#]+)\/(.+)/i);
    if (rawMatch) {
      const [, owner, repo, branch, ...pathParts] = rawMatch;
      const filePath = pathParts.join('/');
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
      log('info', `Fetching raw: ${rawUrl}`);

      const response = await fetch(rawUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }

      const buffer = await response.arrayBuffer().then(ab => Buffer.from(ab));
      const filename = filePath.split('/').pop();

      if (!filename.endsWith('.lua') && !filename.endsWith('.elf')) {
        return res.status(400).json({ error: 'Only .lua and .elf files are supported' });
      }

      const filepath = path.join(payloadsDir, filename);
      fs.writeFileSync(filepath, buffer);

      const db = getDatabase();
      db.run(
        'INSERT INTO payloads (name, filename, filepath, source_url, size) VALUES (?, ?, ?, ?, ?)',
        [filename, filename, filepath, url, buffer.length]
      );
      const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      saveDatabase();

      log('info', `Downloaded: ${filename}`);
      return res.json({ success: true, downloaded: [{ id: lastId, name: filename, size: buffer.length }] });
    }

    throw new Error('Invalid GitHub URL');
  } catch (error) {
    log('error', `Fetch URL failed: ${error.message}`);
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

router.post('/send-raw', async (req, res) => {
  try {
    const { ip, port, name, data } = req.body;

    if (!ip || !port || !data) {
      return res.status(400).json({ error: 'IP, port, and data required' });
    }

    const buffer = Buffer.from(data, 'base64');
    const targetPort = name?.endsWith('.lua') ? 9026 : port;

    log('info', `Sending raw payload to ${ip}:${targetPort}`);

    const net = await import('net');
    const client = new net.Socket();

    await new Promise((resolve, reject) => {
      client.connect(targetPort, ip, () => {
        client.write(buffer, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      client.on('error', reject);
      client.setTimeout(10000);
    });

    client.end();
    client.destroy();

    log('info', `Raw payload sent to ${ip}:${targetPort}`);
    res.json({ success: true, message: `Sent to ${ip}:${targetPort}` });
  } catch (error) {
    log('error', `Send raw failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/send/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { ip } = req.body;

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

    const targetPort = payload.name.toLowerCase().endsWith('.lua') ? 9026 : 9021;

    log('info', `Sending ${payload.name} to ${ip}:${targetPort}`);

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

router.put('/:id/update', async (req, res) => {
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

    if (!payload) {
      return res.status(404).json({ error: 'Payload not found' });
    }

    if (!payload.source_url) {
      return res.status(400).json({ error: 'Payload has no source URL' });
    }

    // Re-download from source URL
    let url = payload.source_url;

    // Convert blob URL to raw URL if needed
    if (url.includes('/blob/')) {
      const blobMatch = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\s?#]+)/i);
      if (blobMatch) {
        const [, owner, repo, filePath] = blobMatch;
        url = `https://raw.githubusercontent.com/${owner}/${repo}/${filePath}`;
      }
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }

    const buffer = await response.arrayBuffer().then(ab => Buffer.from(ab));
    fs.writeFileSync(payload.filepath, buffer);

    db.run('UPDATE payloads SET size = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [buffer.length, parseInt(id)]);
    saveDatabase();

    log('info', `Updated payload: ${payload.name}`);
    res.json({ success: true, message: 'Payload updated' });
  } catch (error) {
    log('error', `Update failed: ${error.message}`);
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