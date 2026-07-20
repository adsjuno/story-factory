'use strict';

/**
 * Luu tru du lieu cuc bo:
 *  - users.json      : danh sach tai khoan nhan su (mat khau da hash)
 *  - settings.json   : cau hinh chung (API key, token FB, login web...) - phan nhay cam duoc ma hoa
 *  - jobs.json       : lich su cac bai da dang
 *
 * Secret (API key, mat khau) duoc ma hoa bang Electron safeStorage (gan voi user OS).
 * Neu chay ngoai Electron (test) thi luu raw - chi dung khi dev.
 */

const fs = require('fs');
const path = require('path');

let safeStorage = null;
try {
  safeStorage = require('electron').safeStorage;
} catch (_) {
  safeStorage = null;
}

let DATA_DIR = null;

function init(userDataPath) {
  DATA_DIR = path.join(userDataPath, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Seed file mac dinh
  ensureFile('users.json', { users: [] });
  ensureFile('settings.json', {});
  ensureFile('jobs.json', { jobs: [] });
  ensureFile('counter.json', { story: 0 });   // bo dem story_id (tang dan)
}

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function ensureFile(name, defaultValue) {
  const p = filePath(name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(defaultValue, null, 2), 'utf8');
}

function read(name) {
  return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
}

function write(name, obj) {
  fs.writeFileSync(filePath(name), JSON.stringify(obj, null, 2), 'utf8');
}

// ---- Ma hoa secret ----
function encryptSecret(plain) {
  if (!plain) return '';
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64');
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (stored.startsWith('enc:')) {
    const buf = Buffer.from(stored.slice(4), 'base64');
    return safeStorage.decryptString(buf);
  }
  if (stored.startsWith('raw:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  }
  return stored;
}

// ---- LOG: luu nguyen van ket qua THO Claude tra ve (de chan doan loi "thieu khuon") ----
function logsDir() {
  const d = path.join(path.dirname(DATA_DIR), 'logs');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Ghi ket qua tho + thong tin chan doan.
 * @param {string} raw   toan bo van ban Claude tra ve
 * @param {object} meta  { at, niche, attempt, ok, missing[], found[], error }
 */
function writeRawLog(raw, meta) {
  try {
    const d = logsDir();
    fs.writeFileSync(path.join(d, 'last-response.txt'), String(raw == null ? '' : raw), 'utf8');
    fs.writeFileSync(path.join(d, 'last-run.json'), JSON.stringify(meta || {}, null, 2), 'utf8');
    // Nhat ky don gian: noi them dong tom tat (giu 200 dong gan nhat)
    const histFile = path.join(d, 'history.log');
    const line = `[${(meta && meta.at) || new Date().toISOString()}] ${(meta && meta.ok) ? 'OK' : 'LOI'}`
      + ` | ngach=${(meta && meta.niche) || '?'}`
      + ` | lan=${(meta && meta.attempt) || '?'}`
      + ` | thieu=${(meta && meta.missing && meta.missing.length) ? meta.missing.join(',') : '-'}`
      + ` | thay=${(meta && meta.found && meta.found.length) ? meta.found.join(',') : '-'}`
      + `${meta && meta.error ? ' | ' + meta.error : ''}`;
    let old = '';
    try { old = fs.readFileSync(histFile, 'utf8'); } catch (_) {}
    const lines = (old ? old.split(/\r?\n/) : []).filter(Boolean);
    lines.push(line);
    fs.writeFileSync(histFile, lines.slice(-200).join('\n') + '\n', 'utf8');
  } catch (_) { /* log hong khong duoc lam sap tien trinh */ }
}

function readRawLog() {
  const out = { raw: '', meta: null, dir: '', file: '', history: '' };
  try {
    const d = logsDir();
    out.dir = d;
    out.file = path.join(d, 'last-response.txt');
    try { out.raw = fs.readFileSync(out.file, 'utf8'); } catch (_) { out.raw = ''; }
    try { out.meta = JSON.parse(fs.readFileSync(path.join(d, 'last-run.json'), 'utf8')); } catch (_) { out.meta = null; }
    try { out.history = fs.readFileSync(path.join(d, 'history.log'), 'utf8'); } catch (_) { out.history = ''; }
  } catch (_) {}
  return out;
}

// ---- Bo dem story_id: moi lan goi +1, tra ve dang 'ST' + 8 chu so ----
function nextStoryId() {
  let c;
  try { c = read('counter.json'); } catch (_) { c = { story: 0 }; }
  c.story = (parseInt(c.story, 10) || 0) + 1;
  write('counter.json', c);
  return 'ST' + String(c.story).padStart(8, '0');
}

module.exports = {
  init,
  read,
  write,
  encryptSecret,
  decryptSecret,
  nextStoryId,
  writeRawLog,
  readRawLog,
  getDataDir: () => DATA_DIR,
  getLogsDir: () => logsDir(),
};
