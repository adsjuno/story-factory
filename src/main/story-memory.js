'use strict';

/**
 * SO CHONG TRUNG (story memory) — ghi lai to hop DNA da dung cho tung bai.
 *
 * LUU TRU: file JSON trong userData/data/story-memory.json
 *   Vi sao KHONG dung SQLite: Electron 31 chay Node 20 (module 'node:sqlite' chi co tu
 *   Node 22.5), con better-sqlite3 la native module phai electron-rebuild + MSVC build
 *   tools -> rui ro lam hong quy trinh build dang chay tot. Du lieu chi vai tram dong
 *   nen JSON du nhanh. API ben duoi co dang giong DB -> sau nay muon doi sang SQLite
 *   chi can thay file nay, khong dong den noi goi.
 *
 * LUAT CHONG TRUNG (tach theo TUNG NUOC):
 *   - hero_name: khong lap trong 200 bai gan nhat CUA CUNG NUOC
 *   - icon_object + twist + ending: khong lap trong 20 bai gan nhat CUNG NGACH, cung nuoc
 */

const store = require('./store');

const FILE = 'story-memory.json';
const MAX_ENTRIES = 5000;                 // tran an toan, cat bot ban ghi qua cu
const HERO_WINDOW = 200;                  // 200 bai gan nhat / nuoc
const COMBO_WINDOW = 20;                  // 20 bai gan nhat / nuoc / ngach

function readDb() {
  try {
    const db = store.read(FILE);
    if (!db || !Array.isArray(db.entries)) return { entries: [] };
    return db;
  } catch (_) {
    return { entries: [] };
  }
}

function writeDb(db) {
  try { store.write(FILE, db); } catch (_) { /* khong duoc lam sap tien trinh viet bai */ }
}

/** Toan bo ban ghi (moi nhat o CUOI mang) */
function all() { return readDb().entries; }

/** N ban ghi gan nhat cua 1 nuoc (moi nhat truoc) */
function recentByCountry(country, n) {
  const c = String(country || '').toUpperCase();
  const list = readDb().entries.filter((e) => String(e.country || '').toUpperCase() === c);
  return list.slice(-Math.max(0, n)).reverse();
}

/** N ban ghi gan nhat cua 1 nuoc + 1 ngach (moi nhat truoc) */
function recentByCountryNiche(country, niche, n) {
  const c = String(country || '').toUpperCase();
  const g = String(niche || '');
  const list = readDb().entries.filter(
    (e) => String(e.country || '').toUpperCase() === c && String(e.niche || '') === g
  );
  return list.slice(-Math.max(0, n)).reverse();
}

/**
 * To hop nay co bi trung khong?
 * @returns {{dup:boolean, reason:string}}
 */
function isDuplicate(combo, country, niche) {
  if (!combo) return { dup: false, reason: '' };

  // 1) hero_name khong lap trong 200 bai gan nhat cua CUNG NUOC
  if (combo.hero_name) {
    const heroes = recentByCountry(country, HERO_WINDOW);
    if (heroes.some((e) => e.combo && e.combo.hero_name === combo.hero_name)) {
      return { dup: true, reason: `hero_name "${combo.hero_name}" đã dùng trong ${HERO_WINDOW} bài gần nhất (${country})` };
    }
  }

  // 2) icon_object + twist + ending khong lap trong 20 bai gan nhat CUNG NGACH
  const recent = recentByCountryNiche(country, niche, COMBO_WINDOW);
  const hit = recent.find((e) => e.combo
    && e.combo.icon_object === combo.icon_object
    && e.combo.twist === combo.twist
    && e.combo.ending === combo.ending);
  if (hit) {
    return { dup: true, reason: `bộ (icon_object + twist + ending) đã dùng trong ${COMBO_WINDOW} bài gần nhất của ngách này` };
  }

  return { dup: false, reason: '' };
}

/** Ghi so 1 bai da chot to hop */
function add({ storyId, country, niche, combo }) {
  const db = readDb();
  db.entries.push({
    story_id: storyId || '',
    at: new Date().toISOString(),
    country: String(country || '').toUpperCase(),
    niche: niche || '',
    combo: combo || {},
  });
  if (db.entries.length > MAX_ENTRIES) db.entries = db.entries.slice(-MAX_ENTRIES);
  writeDb(db);
}

/** Thong ke nhanh (cho man Log / chan doan) */
function stats() {
  const entries = readDb().entries;
  const byCountry = {};
  for (const e of entries) {
    const c = String(e.country || '?').toUpperCase();
    byCountry[c] = (byCountry[c] || 0) + 1;
  }
  return { total: entries.length, byCountry };
}

module.exports = {
  all, recentByCountry, recentByCountryNiche, isDuplicate, add, stats,
  HERO_WINDOW, COMBO_WINDOW, FILE,
};
