import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { initializeDatabase } from './db/init.js';
import payloadsRouter from './routes/payloads.js';
import profilesRouter from './routes/profiles.js';
import ps5Router from './routes/ps5.js';
import logsRouter from './routes/logs.js';
import backupRouter from './routes/backup.js';
import logServerRouter, { startLogServer } from './routes/logServer.js';
import kernelLogServerRouter, { startKernelLogServer } from './routes/kernelLogServer.js';
import ps5ControlRouter from './routes/ps5control.js';
import sequencesRouter from './routes/sequences.js';
import settingsRouter from './routes/settings.js';
import inputScriptsRouter from './routes/inputScripts.js';
import convertRouter from './routes/convert.js';
import downloaderRouter from './routes/downloader.js';
import eventsRouter from './routes/events.js';
import remoteplayRouter from './routes/remoteplay.js';
import builtinRouter from './routes/builtin.js';
import { ensureDefaultPayloads } from './lib/defaultPayloads.js';
import { migratePaths } from './lib/migrate-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Suppress the most chatty polling endpoints from the access log - the UI
// hits ps5/status, remoteplay/health and remoteplay/quick-status every few
// seconds and they used to dominate the unified Logs view.
const ACCESS_LOG_SILENCE = [
  /^\/api\/ps5\/status\//,
  /^\/api\/remoteplay\/health$/,
  /^\/api\/remoteplay\/quick-status$/,
  /^\/api\/kernellog\/status$/,
  /^\/api\/logserver\/status$/,
  /^\/api\/convert\/ftp\/upload\/queue$/, // queue poll
  /^\/api\/sequences$/,
  /^\/api\/logs$/,
];
app.use((req, res, next) => {
  const silent = ACCESS_LOG_SILENCE.some(rx => rx.test(req.path));
  if (!silent) console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use('/api/payloads', payloadsRouter);
app.use('/api/profiles', profilesRouter);
app.use('/api/ps5', ps5Router);
app.use('/api/logs', logsRouter);
app.use('/api/backup', backupRouter);
app.use('/api/logserver', logServerRouter);
app.use('/api/kernellog', kernelLogServerRouter);
app.use('/api/ps5control', ps5ControlRouter);
app.use('/api/sequences', sequencesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/input-scripts', inputScriptsRouter);
// Mounted at /api/convert (was /api/micromount before the rename); kept as a
// single big router covering FS browse, FTP upload queue, extract, convert
// (pack/unpack via mkpfs) and the remote sources used by the file browser.
app.use('/api/convert', convertRouter);
// Backwards-compatibility alias so old browser tabs / scripts still work
// against the previous URL prefix. Remove once everyone has refreshed.
app.use('/api/micromount', convertRouter);
app.use('/api/downloader', downloaderRouter);
app.use('/api/events', eventsRouter);
app.use('/api/remoteplay', remoteplayRouter);
app.use('/api/builtin', builtinRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const distPath = path.join(__dirname, '../dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

await initializeDatabase();

// Layout migration: ensure /data/{payloads,mkpfs,downloads} exist and
// move any legacy /app/data/{payloads,mkpfs} content over. Runs once,
// idempotent. See backend/src/lib/migrate-paths.js for details.
try { migratePaths(); } catch (e) { console.warn(`[migrate-paths] ${e.message}`); }

// Auto-start log server
startLogServer(8080);

// Auto-start kernel log server
startKernelLogServer(3232);

// Make sure built-in templates and log viewer have the payloads they need,
// even on an empty database. Runs in the background so a slow network does
// not block API startup.
ensureDefaultPayloads().then((s) => {
  console.log(`[defaults] payloads added=${s.added.length} skipped=${s.skipped.length} failed=${s.failed.length}`);
}).catch((e) => {
  console.warn(`[defaults] payload bootstrap error: ${e.message}`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`P5 Manager API running on port ${PORT}`);
});