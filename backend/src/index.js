import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './db/init.js';
import payloadsRouter from './routes/payloads.js';
import profilesRouter from './routes/profiles.js';
import ps5Router from './routes/ps5.js';
import logsRouter from './routes/logs.js';
import backupRouter from './routes/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use('/api/payloads', payloadsRouter);
app.use('/api/profiles', profilesRouter);
app.use('/api/ps5', ps5Router);
app.use('/api/logs', logsRouter);
app.use('/api/backup', backupRouter);

const distPath = path.join(__dirname, '../../dist');
if (process.env.NODE_ENV === 'production' && require('fs').existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

await initializeDatabase();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PS5 PayloadManager API running on port ${PORT}`);
});