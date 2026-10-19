// Community game reports: "[Game report]" issues on theghostonline.dev,
// counted here (one vote per person per game, their newest report wins).
import {FileSystem, Http, Platform} from '@ps5-react/core';
import {APP_VERSION} from './version.js';

const SITE = 'https://theghostonline.dev';
const REPO = 'theghostonline/PS5-LZ4-Compression';
const ISSUES_URL = `${SITE}/api/v1/repos/${REPO}/issues?state=all&type=issues&limit=50`;
const MAX_PAGES = 20;
const DATA = Platform.OS === 'ps5' ? '/data/LZ4Compression' : `${FileSystem.dataDir}/LZ4Compression`;
const CACHE = `${DATA}/compat-cache.json`;
const REPORTED = `${DATA}/compat-reported.json`;
// A test copy of the issue list can be pointed at with this file.
const COMPAT_OVERRIDE = `${DATA}/compat-url`;

const FIELDS = {
  'title id': 'titleId', 'game': 'game', 'how does it run?': 'status', 'game version': 'gameVersion',
};
const IGNORED_LABELS = ['invalid', 'duplicate', 'spam'];

export const REPORT_CHOICES = [
  {status: 'works', label: 'Works', form: 'Works'},
  {status: 'issues', label: 'Works with issues', form: 'Works with issues'},
  {status: 'noStart', label: "Won't start", form: "Won't start (black screen or crash on launch)"},
  {status: 'crash', label: 'Crashes in game', form: 'Crashes in game'},
];

function readJson(path, fallback) {
  try {
    return FileSystem.exists(path) ? JSON.parse(FileSystem.readFile(path)) : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(path, value) {
  try {
    FileSystem.mkdir(DATA, {recursive: true});
    FileSystem.writeFile(path, JSON.stringify(value));
  } catch (err) {
    // Only a cache.
  }
}

// A report's fields: the form writes "### Label" and the answer under it.
function parseBody(body) {
  const out = {};
  const parts = String(body || '').split(/^### +(.+?)\s*$/m);
  for (let i = 1; i < parts.length - 1; i += 2) {
    const key = FIELDS[parts[i].trim().toLowerCase()];
    const value = parts[i + 1].trim();
    if (key && value && value !== '_No response_') out[key] = value.replace(/\s+/g, ' ');
  }
  return out;
}

export function countReports(issues) {
  const latest = new Map();
  for (const issue of issues) {
    const labels = (issue.labels || []).map(label => String(label.name || '').toLowerCase());
    if (labels.some(label => IGNORED_LABELS.includes(label))) continue;
    const fields = parseBody(issue.body);
    const titleId = String(fields.titleId || '').toUpperCase();
    const choice = REPORT_CHOICES.find(item => item.form.toLowerCase() === String(fields.status || '').toLowerCase());
    if (!/^[A-Z]{4}\d{5}$/.test(titleId) || !choice) continue;
    // Reports moved over from GitHub start with their original issue, author (when known) and date.
    const moved = /^_Moved from GitHub #(\d+), opened (?:by @([\w-]+) )?on (\d{4}-\d{2}-\d{2})/.exec(issue.body || '');
    const author = String(moved ? moved[2] || `github#${moved[1]}` : (issue.user && issue.user.login) || `#${issue.number}`).toLowerCase();
    const date = moved ? moved[3] : issue.created_at || '';
    const report = {status: choice.status, game: String(fields.game || '').slice(0, 80), date};
    const key = `${titleId} ${author}`;
    const seen = latest.get(key);
    if (!seen || report.date >= seen.report.date) latest.set(key, {titleId, report});
  }
  const games = {};
  for (const {titleId, report} of latest.values()) {
    const game = games[titleId] || (games[titleId] = {name: '', works: 0, issues: 0, noStart: 0, crash: 0, reports: 0});
    game[report.status]++;
    game.reports++;
    if (report.game && !game.name) game.name = report.game;
  }
  return games;
}

// The reports, or the last copy that loaded when the site can't be reached.
export async function loadCompat() {
  try {
    let url = ISSUES_URL;
    try {
      if (FileSystem.exists(COMPAT_OVERRIDE)) url = FileSystem.readFile(COMPAT_OVERRIDE).trim() || ISSUES_URL;
    } catch (err) {
      // Use the real list.
    }
    const issues = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await Http.request(`${url}&page=${page}`, {maxBytes: 4 * 1024 * 1024});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('Not an issue list');
      issues.push(...batch);
      if (batch.length < 50) break;
    }
    const games = countReports(issues);
    writeJson(CACHE, games);
    return games;
  } catch (err) {
    return readJson(CACHE, {});
  }
}

// "Works for 4 of 5", or null when nobody has reported the game yet.
export function compatSummary(entry) {
  if (!entry || !entry.reports) return null;
  const working = (entry.works || 0) + (entry.issues || 0);
  const broken = (entry.noStart || 0) + (entry.crash || 0);
  const text = working && !broken ? `Works for ${entry.reports === 1 ? '1 person' : `all ${entry.reports}`}`
    : !working ? `Broken for ${entry.reports === 1 ? '1 person' : `all ${entry.reports}`}`
    : `Works for ${working} of ${entry.reports}`;
  return {text, tone: broken > working ? 'bad' : broken ? 'warn' : 'good'};
}

export function loadReported() {
  return readJson(REPORTED, {});
}

export function markReported(titleId, status) {
  const all = readJson(REPORTED, {});
  all[titleId] = status;
  writeJson(REPORTED, all);
}

// A prefilled "Game report" issue, short enough to scan off a TV. Firmware
// and notes are left for the person to fill in.
export function reportUrl(game, status) {
  const choice = REPORT_CHOICES.find(item => item.status === status) || REPORT_CHOICES[0];
  const name = String(game.name || '').slice(0, 60);
  const fields = [
    ['Title ID', game.titleId],
    ['Game', name],
    ['How does it run?', choice.form],
    ['Game version', game.version || game.contentVersion || ''],
    ['LZ4 Compression version', APP_VERSION],
    ['Firmware', ''],
    ['Notes', ''],
  ];
  const body = fields.map(([label, value]) => `### ${label}\n\n${value}`).join('\n\n');
  const title = `[Game report] ${name || game.titleId}: ${choice.label}`;
  return `${SITE}/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
