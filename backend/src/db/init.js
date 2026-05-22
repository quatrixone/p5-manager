import { initDatabase, log, getLogs, clearLogs } from './sqlite.js';

let initialized = false;

export async function initializeDatabase() {
  if (initialized) return;
  await initDatabase();
  initialized = true;
  log('info', 'PS5 PayloadManager API started');
}

export { log, getLogs, clearLogs };