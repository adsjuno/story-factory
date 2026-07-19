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
  getDataDir: () => DATA_DIR,
};
