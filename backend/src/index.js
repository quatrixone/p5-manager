import express from 'express';
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

// CORS: in dev the Vite proxy already strips the cross-origin header
// for us, but in production this stack serves the SPA from the same
// host as the API (host networking, single port). The right policy is
// "same-origin as this server" - any browser tab opened against
// http://<this-host>:<this-port> is the legitimate UI. We honour three
// things:
//
//   1. No Origin header at all (curl, server-to-server, same-origin
//      fetch from the SPA on the same host:port) - always allowed.
//   2. Origin whose host:port matches the request's Host header - the
//      classic "I am being asked from myself" case. This covers
//      localhost, the LAN IP (10.0.0.187, …), Docker hostnames, and
//      whatever else the user resolves the box as.
//   3. An explicit P5M_ALLOWED_ORIGINS env var (comma-separated) for
//      the rare case where the user puts the app behind a reverse
//      proxy with a different origin (e.g. https://p5.example.com →
//      http://10.0.0.5:3001).
//
// Anything else (e.g. a third-party webpage trying to call the REST
// API) is rejected.
const EXPLICIT_ORIGINS = (process.env.P5M_ALLOWED_ORIGINS
  ? process.env.P5M_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : []);

// Hand-rolled CORS middleware: the `cors` package's origin callback
// doesn't receive `req`, but we need the Host header to recognise a
// same-origin request from a LAN IP. We set the right CORS headers
// directly and short-circuit the preflight.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allowed = !origin;                            // no Origin → always OK
  if (!allowed && EXPLICIT_ORIGINS.includes(origin)) allowed = true;
  if (!allowed) {
    try {
      const u = new URL(origin);
      if (`${u.host}` === req.headers.host) allowed = true;
    } catch (_) { /* malformed origin */ }
  }
  if (allowed) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') {
    // Preflight: respond 204 with the headers above. The browser will
    // not actually call the route, so we don't need to do anything else.
    return res.status(204).end();
  }
  // The 'cors' package would normally also attach the header. We no
  // longer call app.use(cors()) — this middleware replaces it. We
  // still let it through for non-CORS requests (curl, server-to-server).
  return next();
});
// 16 MB is enough for any normal payload upload (POST /payloads/upload
// takes the whole file base64-encoded in the body). 12 MB binary
// inflates to ~16 MB base64 + JSON overhead. Larger files have to go
// through the file-browser's upload-to-tmp-then-import flow or the
// /fetch-url endpoint, which never round-trips through this body.
app.use(express.json({ limit: '16mb' }));

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
  // Cache strategy:
  //   - /assets/* uses content-hashed filenames (index-<hash>.js) so we can
  //     safely tell the browser to cache them forever (immutable).
  //   - sw.js, index.html, registerSW.js, manifest.webmanifest, workbox-*.js
  //     MUST always revalidate so a fresh build's service-worker + entry
  //     html are picked up immediately. Without this, PWAs stay pinned to
  //     the previously-installed bundle until the user manually clears
  //     cache or unregisters the SW — which is exactly what makes "I
  //     can't see my new data / new features" tickets so common after a
  //     deploy.
  app.use(express.static(distPath, {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      const rel = path.relative(distPath, filePath).replace(/\\/g, '/');
      if (rel.startsWith('assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (
        rel === 'sw.js' ||
        rel === 'registerSW.js' ||
        rel === 'index.html' ||
        rel === 'manifest.webmanifest' ||
        /^workbox-[^/]+\.js$/.test(rel)
      ) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return;
      }
    },
  }));
  app.get('*', (req, res) => {
    // SPA fallback: index.html should never be cached for the same reason
    // as above — the new bundle hash lives inside it.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
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