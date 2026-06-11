import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';
import { ensureDefaultPayloads, getEssentialPayloads, scanPayloadsDir } from '../lib/defaultPayloads.js';
import { pushKernelLogEntry } from './kernelLogServer.js';
import { payloadsDir } from '../lib/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

function ensurePayloadsDir() {
  if (!fs.existsSync(payloadsDir)) {
    fs.mkdirSync(payloadsDir, { recursive: true });
  }
}

// Heuristic platform detection from filename + URL. Used for any payload
// the user adds (GitHub fetch, file upload) that doesn't already carry an
// explicit console_type. PS4 GoldHEN-ecosystem payloads are .bin and
// frequently include "goldhen" / "hen" / "mira" in the URL; PS5 payloads
// are .lua / .elf and live under ps5-payload-dev, BestPig, EchoStretch
// etc. Returns 'ps4' | 'ps5' | null (= "could be either").
function detectConsoleTypeFromHints({ filename, url } = {}) {
  const lc = (filename || '').toLowerCase();
  const urlLc = (url || '').toLowerCase();
  const blob = lc + ' ' + urlLc;

  // .bin is essentially PS4-only in our context.
  if (lc.endsWith('.bin')) return 'ps4';

  // Strong PS4 keywords.
  if (/(^|[^a-z])(goldhen|mira|gold_hen|jkpatch)([^a-z]|$)/.test(blob)) return 'ps4';
  if (/(\b)(ps4|fw9\.00|fw5\.05|fw7\.55|fw6\.72)(\b)/.test(blob)) return 'ps4';

  // Strong PS5 keywords / repos.
  if (/ps5-payload-dev|ps5_payload|byepervisor|kstuff|backpork|micromount|p2jb/.test(blob)) return 'ps5';
  if (/(\b)ps5(\b)/.test(blob)) return 'ps5';
  if (lc.endsWith('.lua')) return 'ps5';

  // .elf alone isn't a strong signal — both consoles use ELF binaries.
  return null;
}

router.get('/', (req, res) => {
  try {
    // Pick up any .lua/.elf/.bin files dropped into data/payloads/ by
    // means other than the UI (FTP, SCP, file-browser, host volume).
    // scanPayloadsDir() is idempotent and bails out fast when nothing
    // new is on disk, so calling it on every list-request is cheap.
    try { scanPayloadsDir(); } catch (e) { log('error', `scanPayloadsDir failed: ${e.message}`); }

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

// List the essential built-in payloads that the manager auto-installs.
router.get('/defaults', async (req, res) => {
  try {
    const list = await getEssentialPayloads();
    res.json(list.map(p => ({
      filename: p.filename,
      url: p.url,
      tag: p.tag,
      description: p.description,
    })));
  } catch (err) {
    log('error', `Failed to load default payloads list: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Manually re-run the default-payload bootstrap. With ?force=1, re-download
// even payloads that already exist (overwrites the local files).
router.post('/defaults/restore', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.body?.force === true;
    const summary = await ensureDefaultPayloads({ force });
    res.json({ success: true, ...summary });
  } catch (error) {
    log('error', `Restore defaults failed: ${error.message}`);
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

    const db = getDatabase();

    // Check if payload with this URL already exists
    const existingStmt = db.prepare('SELECT id FROM payloads WHERE source_url = ?');
    existingStmt.bind([url]);
    const exists = existingStmt.step();
    existingStmt.free();
    if (exists) {
      return res.json({ success: true, downloaded: [], message: 'Payload already exists' });
    }

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
      const version = release.tag_name || 'latest';

      for (const asset of release.assets) {
        const name = asset.name.toLowerCase();
        const isLuaOrElf = name.endsWith('.lua') || name.endsWith('.elf') || name.endsWith('.bin');
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
                if (entryName.endsWith('.lua') || entryName.endsWith('.elf') || entryName.endsWith('.bin')) {
                  const entryBuffer = entry.getData();
                  const filename = entry.entryName.split('/').pop();
                  const filepath = path.join(payloadsDir, filename);

                  fs.writeFileSync(filepath, entryBuffer);
                  const consoleType = detectConsoleTypeFromHints({ filename, url: downloadUrl });
                  db.run(
                    'INSERT INTO payloads (name, filename, filepath, source_url, size, version, console_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [filename, filename, filepath, downloadUrl, entryBuffer.length, version, consoleType]
                  );
                  const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
                  results.push({ id: lastId, name: filename, size: entryBuffer.length, version, console_type: consoleType });
                  log('info', `Extracted from ZIP ${version}: ${entry.entryName}`);
                }
              }
            } catch (zipError) {
              log('error', `Failed to extract ZIP ${asset.name}: ${zipError.message}`);
            }
          } else {
            const filename = asset.name;
            const filepath = path.join(payloadsDir, filename);

            fs.writeFileSync(filepath, buffer);
            const consoleType = detectConsoleTypeFromHints({ filename, url: downloadUrl });
            db.run(
              'INSERT INTO payloads (name, filename, filepath, source_url, size, version, console_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [filename, filename, filepath, downloadUrl, buffer.length, version, consoleType]
            );
            const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
            results.push({ id: lastId, name: filename, size: buffer.length, version, console_type: consoleType });
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
      const decodedPath = decodeURIComponent(filePath);
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${decodedPath}`;
      log('info', `Fetching raw: ${rawUrl}`);

      const response = await fetch(rawUrl, {
        headers: { 'Accept': 'application/octet-stream' },
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer().then(ab => Buffer.from(ab));
      const filename = decodedPath.split('/').pop();

      if (!buffer.length) {
        throw new Error('Downloaded file is empty');
      }

      if (filename.endsWith('.lua') || filename.endsWith('.elf') || filename.endsWith('.bin')) {
        // Check if already exists
        const checkStmt = db.prepare('SELECT id FROM payloads WHERE source_url = ?');
        checkStmt.bind([url]);
        if (checkStmt.step()) {
          checkStmt.free();
          return res.json({ success: true, downloaded: [], message: 'Payload already exists' });
        }
        checkStmt.free();

        const filepath = path.join(payloadsDir, filename);
        fs.writeFileSync(filepath, buffer);

        const consoleType = detectConsoleTypeFromHints({ filename, url });
        db.run(
          'INSERT INTO payloads (name, filename, filepath, source_url, size, console_type) VALUES (?, ?, ?, ?, ?, ?)',
          [filename, filename, filepath, url, buffer.length, consoleType]
        );
        const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        saveDatabase();

        log('info', `Downloaded: ${filename} (${buffer.length} bytes)`);
        return res.json({ success: true, downloaded: [{ id: lastId, name: filename, size: buffer.length, console_type: consoleType }] });
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
      const filename = decodeURIComponent(filePath.split('/').pop());

      if (!filename.endsWith('.lua') && !filename.endsWith('.elf') && !filename.endsWith('.bin')) {
        return res.status(400).json({ error: 'Only .lua, .elf and .bin files are supported' });
      }

      // Check if already exists
      const checkStmt = db.prepare('SELECT id FROM payloads WHERE source_url = ?');
      checkStmt.bind([url]);
      if (checkStmt.step()) {
        checkStmt.free();
        return res.json({ success: true, downloaded: [], message: 'Payload already exists' });
      }
      checkStmt.free();

      const filepath = path.join(payloadsDir, filename);
      fs.writeFileSync(filepath, buffer);

      const consoleType = detectConsoleTypeFromHints({ filename, url });
      db.run(
        'INSERT INTO payloads (name, filename, filepath, source_url, size, console_type) VALUES (?, ?, ?, ?, ?, ?)',
        [filename, filename, filepath, url, buffer.length, consoleType]
      );
      const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      saveDatabase();

      log('info', `Downloaded: ${filename}`);
      return res.json({ success: true, downloaded: [{ id: lastId, name: filename, size: buffer.length, console_type: consoleType }] });
    }

    throw new Error('Invalid GitHub URL');
  } catch (error) {
    log('error', `Fetch URL failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/upload', (req, res) => {
  try {
    // `console_type` is optional. When omitted we try to infer from the
    // filename so the UI can immediately filter the upload into the right
    // platform bucket; the user can correct via the manual update endpoint.
    const { name, data, console_type } = req.body;

    if (!name || !data) {
      return res.status(400).json({ error: 'Name and data required' });
    }

    ensurePayloadsDir();

    const buffer = Buffer.from(data, 'base64');
    const db = getDatabase();
    const isZip = name.toLowerCase().endsWith('.zip');

    // ZIP path: walk every entry, keep only the supported payload
    // formats (.lua / .elf / .bin) and ignore everything else (README,
    // source, screenshots, nested archives, ...). Each extracted file
    // becomes its own payloads row, so the UI lists them individually
    // and the user can send / update them independently. The original
    // archive is not retained on disk - it has no use once unpacked.
    if (isZip) {
      let zip;
      try {
        zip = new AdmZip(buffer);
      } catch (zipErr) {
        return res.status(400).json({ error: `Invalid ZIP file: ${zipErr.message}` });
      }

      const SUPPORTED_EXT = ['.lua', '.elf', '.bin'];
      const extracted = [];
      const skipped = [];

      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        // Take the basename so nested paths like "Release/foo.elf"
        // collapse to "foo.elf" - mirrors how /fetch-url handles ZIPs.
        const filename = entry.entryName.split('/').pop();
        if (!filename) continue;
        const lc = filename.toLowerCase();

        if (!SUPPORTED_EXT.some(ext => lc.endsWith(ext))) {
          skipped.push(entry.entryName);
          continue;
        }

        const entryBuffer = entry.getData();
        const filepath = path.join(payloadsDir, filename);
        fs.writeFileSync(filepath, entryBuffer);

        const detected = detectConsoleTypeFromHints({ filename });
        const finalConsoleType = (console_type === 'ps4' || console_type === 'ps5')
          ? console_type
          : detected;

        db.run(
          'INSERT INTO payloads (name, filename, filepath, size, console_type) VALUES (?, ?, ?, ?, ?)',
          [filename, filename, filepath, entryBuffer.length, finalConsoleType]
        );
        const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        extracted.push({
          id: lastId,
          name: filename,
          size: entryBuffer.length,
          console_type: finalConsoleType,
        });
        log('info', `Extracted from ZIP ${name}: ${filename}${finalConsoleType ? ` (${finalConsoleType})` : ''}`);
      }

      if (extracted.length === 0) {
        return res.status(400).json({
          error: 'ZIP contained no supported payloads (.lua / .elf / .bin)',
          skipped,
        });
      }

      saveDatabase();
      return res.json({
        success: true,
        zip: true,
        extracted,
        skipped,
        message: `Extracted ${extracted.length} payload(s) from ZIP${skipped.length ? `; ignored ${skipped.length} unsupported file(s)` : ''}`,
      });
    }

    // Plain single-file upload: only accept the supported extensions
    // so users can't drop random binaries into payloads/ via the form.
    const lcName = name.toLowerCase();
    if (!(lcName.endsWith('.lua') || lcName.endsWith('.elf') || lcName.endsWith('.bin'))) {
      return res.status(400).json({ error: 'Only .lua, .elf, .bin and .zip files are supported' });
    }

    const filepath = path.join(payloadsDir, name);
    fs.writeFileSync(filepath, buffer);

    const detected = detectConsoleTypeFromHints({ filename: name });
    const finalConsoleType = (console_type === 'ps4' || console_type === 'ps5')
      ? console_type
      : detected;

    db.run(
      'INSERT INTO payloads (name, filename, filepath, size, console_type) VALUES (?, ?, ?, ?, ?)',
      [name, name, filepath, buffer.length, finalConsoleType]
    );

    const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    saveDatabase();

    log('info', `Uploaded payload: ${name}${finalConsoleType ? ` (${finalConsoleType})` : ''}`);

    res.json({ success: true, id: lastId, console_type: finalConsoleType });
  } catch (error) {
    log('error', `Upload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Manual override of the platform tag for an existing payload (e.g. the
// detector got it wrong, or the user wants to retag an .elf they know is
// for the other console).
router.put('/:id/console-type', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const raw = req.body?.console_type;
    const consoleType = (raw === 'ps4' || raw === 'ps5') ? raw : null;
    const db = getDatabase();
    db.run('UPDATE payloads SET console_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [consoleType, id]);
    saveDatabase();
    res.json({ success: true, id, console_type: consoleType });
  } catch (error) {
    log('error', `Update payload console_type failed: ${error.message}`);
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
    // Same port heuristic as POST /send/:id — .lua = PS5 Lua port 9026,
    // .bin = PS4 GoldHEN port 9020, anything else honors the explicit
    // `port` provided by the caller (default falls back to PS5 ELF 9021).
    const nameLc = (name || '').toLowerCase();
    let inferred = port;
    if (nameLc.endsWith('.lua')) inferred = 9026;
    else if (nameLc.endsWith('.bin')) inferred = 9020;
    const targetPort = inferred || port || 9021;

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

    let filepath = payload.filepath;
    // Check if file exists at stored path, otherwise try current payloadsDir
    if (!fs.existsSync(filepath)) {
      const alternatePath = path.join(payloadsDir, path.basename(filepath));
      if (fs.existsSync(alternatePath)) {
        filepath = alternatePath;
      } else {
        return res.status(404).json({ error: 'Payload file not found on disk' });
      }
    }

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Payload file not found on disk' });
    }

    const fileData = fs.readFileSync(filepath);

    // Port selection: the file extension is authoritative for formats
    // that have a fixed listener port. The frontend always passes
    // `profile.port` (which is the *ELF* port, usually 9021), so blindly
    // honouring it would route .lua to 9021 and .bin to 9021 — both
    // wrong. We only fall back to the caller-supplied `port` for the
    // ambiguous .elf case, where the user may legitimately want to hit
    // a non-default listener.
    //   .lua            → 9026  (PS5 Lua exploit chain)
    //   .bin / PS4 row  → 9020  (PS4 GoldHEN payload sender)
    //   .elf and friends→ req.body.port || 9021  (PS5 ELF default)
    const nameLc = (payload.name || '').toLowerCase();
    let targetPort;
    if (nameLc.endsWith('.lua')) targetPort = 9026;
    else if (nameLc.endsWith('.bin') || payload.console_type === 'ps4') targetPort = 9020;
    else targetPort = req.body?.port || 9021;

    log('info', `Sending ${payload.name} to ${ip}:${targetPort}`);

    const net = await import('net');
    const client = new net.Socket();
    const tag = payload.name;

    // Push the ELF, half-close so elfldr sees EOF and starts executing, then
    // keep the read side open: PS5 elfldr inherits stdin/stdout/stderr from
    // the same socket, so any printf/dprintf the payload performs streams
    // back here and we forward it into the kernel-log buffer with the
    // payload name as tag. The HTTP response returns as soon as the write
    // succeeds - output capture continues in the background.
    let writeOk = false;
    let leftover = '';
    let totalBytes = 0;

    client.on('data', (chunk) => {
      totalBytes += chunk.length;
      const text = leftover + chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      leftover = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) pushKernelLogEntry(line, ip, tag);
      }
    });

    client.on('close', () => {
      if (leftover.trim()) pushKernelLogEntry(leftover, ip, tag);
      if (totalBytes > 0) log('info', `Payload ${payload.name} produced ${totalBytes} B of output`);
    });

    client.on('error', (err) => {
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return; // normal at exit
      log('warn', `Payload ${payload.name} socket error: ${err.message}`);
    });

    // Hard cap so long-running payloads (klogsrv etc.) don't keep this socket
    // around forever - klogsrv has its own port-3232 channel anyway.
    client.setTimeout(60_000, () => {
      try { client.destroy(); } catch (_) {}
    });

    await new Promise((resolve, reject) => {
      client.connect(targetPort, ip, () => {
        client.write(fileData, (err) => {
          if (err) return reject(err);
          writeOk = true;
          // Half-close the write side: PS5 elfldr reads until EOF before
          // executing the ELF, so this is required to actually launch the
          // payload. The socket stays open for reads.
          client.end();
          resolve();
        });
      });
      // Reject on early connect errors only; post-write errors are handled
      // by the listener above and shouldn't fail the HTTP response.
      const earlyError = (err) => { if (!writeOk) reject(err); };
      client.once('error', earlyError);
    });

    log('info', `Payload ${payload.name} sent successfully`);

    res.json({
      success: true,
      message: `Sent to ${ip}:${targetPort} - output streaming to Logs`,
    });
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

    let url = payload.source_url;
    let newVersion = null;
    let resolvedFilename = payload.filename || path.basename(payload.filepath || '');

    // Releases URL: swap the stored tag with the latest release's tag in the
    // download URL so we actually fetch the new asset. We try to match the
    // original filename to an asset in the new release first; if that fails
    // we fall back to a literal tag swap and finally to the raw stored URL.
    const releasesMatch = payload.source_url.match(/github\.com\/([^\/]+)\/([^\/]+)\/releases(?:\/tag\/([^\/\?#]+)|\/download\/([^\/\?#]+))\/([^\s?#]+)/i);
    if (releasesMatch) {
      const [, owner, repo, tagFromTag, tagFromDownload, assetNameInUrl] = releasesMatch;
      const oldTag = tagFromDownload || tagFromTag;
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
      const response = await fetch(apiUrl, { headers: { 'Accept': 'application/vnd.github.v3+json' } });
      if (response.ok) {
        const release = await response.json();
        newVersion = release.tag_name || 'latest';

        if (newVersion && payload.version === newVersion) {
          return res.json({ success: false, error: 'No newer version available', currentVersion: payload.version, newVersion: null });
        }

        // Prefer the asset whose name matches the existing filename, then any
        // asset sharing the same extension, then any asset at all.
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const ext = path.extname(resolvedFilename || assetNameInUrl).toLowerCase();
        const byExactName = assets.find(a => a.name === resolvedFilename);
        const byExt = ext ? assets.find(a => path.extname(a.name).toLowerCase() === ext) : null;
        const chosen = byExactName || byExt || assets[0];
        if (chosen) {
          url = chosen.browser_download_url;
          resolvedFilename = chosen.name;
        } else if (oldTag) {
          // No asset listed (private repo? rare). Try a literal tag swap.
          url = url.replace(`/releases/download/${oldTag}/`, `/releases/download/${newVersion}/`);
        }
      }
    }

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

    let buffer = await response.arrayBuffer().then(ab => Buffer.from(ab));

    // If the chosen asset is a ZIP, mirror the POST /fetch-url behaviour and
    // extract the matching .elf/.lua entry. Otherwise we'd happily overwrite
    // the existing ELF with a zip blob and the PS5 loader would EPIPE us.
    const isZip = url.toLowerCase().endsWith('.zip')
      || resolvedFilename.toLowerCase().endsWith('.zip')
      || (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04);

    if (isZip) {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const oldExt = path.extname(payload.filename || '').toLowerCase() || '.elf';
      const oldBase = path.basename(payload.filename || '', oldExt).toLowerCase();
      const matchExtEntry = (ext) => entries.find(e => !e.isDirectory && path.extname(e.entryName).toLowerCase() === ext);
      const matchBaseEntry = entries.find(e => {
        if (e.isDirectory) return false;
        const n = path.basename(e.entryName).toLowerCase();
        return n === (payload.filename || '').toLowerCase() || n.startsWith(oldBase);
      });
      const elfOrLua = matchBaseEntry
        || matchExtEntry(oldExt)
        || matchExtEntry('.elf')
        || matchExtEntry('.lua');
      if (!elfOrLua) {
        throw new Error('No .elf/.lua file found inside release ZIP');
      }
      buffer = elfOrLua.getData();
      resolvedFilename = path.basename(elfOrLua.entryName);
      log('info', `Update: extracted ${elfOrLua.entryName} from ZIP for ${payload.name}`);
    }

    // Sanity check: refuse to write a payload that clearly isn't a binary the
    // PS5 loader can run. ELF starts with 7F 45 4C 46. Lua is text so we
    // don't validate it.
    const isElfExt = resolvedFilename.toLowerCase().endsWith('.elf');
    if (isElfExt && !(buffer.length >= 4 && buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46)) {
      throw new Error('Downloaded file is not a valid ELF (missing magic bytes)');
    }

    // Ensure file is written to current payloadsDir. If the asset name changed
    // across releases, move to the new filename and drop the old one.
    let filepath = payload.filepath;
    const desiredPath = path.join(payloadsDir, resolvedFilename);
    if (filepath !== desiredPath) {
      if (filepath && fs.existsSync(filepath) && filepath !== desiredPath) {
        try { fs.unlinkSync(filepath); } catch (_) {}
      }
      filepath = desiredPath;
    } else if (!fs.existsSync(filepath) || !filepath.startsWith(payloadsDir)) {
      filepath = desiredPath;
    }
    fs.writeFileSync(filepath, buffer);

    db.run(
      'UPDATE payloads SET filename = ?, filepath = ?, size = ?, source_url = ?, version = COALESCE(?, version), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [resolvedFilename, filepath, buffer.length, url, newVersion, parseInt(id)]
    );
    saveDatabase();

    log('info', `Updated payload: ${payload.name}${newVersion ? ` -> ${newVersion}` : ''}`);
    res.json({ success: true, message: 'Payload updated', newVersion });
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

router.get('/:id/check-update', async (req, res) => {
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
      return res.json({ success: false, error: 'No source URL' });
    }

    // Match both /releases/assets/ and /releases/download/ URL formats
    const releasesMatch = payload.source_url.match(/github\.com\/([^\/]+)\/([^\/]+)\/releases(?:\/tag\/([^\/\?#]+)|\/download\/([^\/\?#]+))\/([^\s?#]+)/i);
    if (!releasesMatch) {
      return res.json({ success: false, error: 'Not a releases URL' });
    }

    const [, owner, repo] = releasesMatch;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const response = await fetch(apiUrl, { headers: { 'Accept': 'application/vnd.github.v3+json' } });

    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: 'GitHub API error' });
    }

    const release = await response.json();
    const newVersion = release.tag_name || 'latest';

    if (payload.version === newVersion) {
      return res.json({ success: true, updateAvailable: false, currentVersion: payload.version, newVersion: null });
    }

    res.json({ success: true, updateAvailable: true, currentVersion: payload.version, newVersion });
  } catch (error) {
    log('error', `Check update failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;