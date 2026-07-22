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

// ---- Helpers DEDUP THEO NGAY (cho engine v2) ----
function nowMs() { return Date.now(); }
function entryDays(e, now) {
  const t = Date.parse(e.at || '') || 0;
  if (!t) return Infinity;
  return (now - t) / 86400000; // ms -> ngay
}
function entriesOfCountry(country) {
  const c = String(country || '').toUpperCase();
  return readDb().entries.filter((e) => String(e.country || '').toUpperCase() === c);
}

/** So NGAY ke tu lan gan nhat 1 truc (field trong combo) mang gia tri `value`. Infinity neu chua tung. */
function daysSinceField(country, field, value, now = nowMs()) {
  if (value == null || value === '') return Infinity;
  const list = entriesOfCountry(country);
  let best = Infinity;
  for (const e of list) {
    if (e.combo && e.combo[field] === value) {
      const d = entryDays(e, now);
      if (d < best) best = d;
    }
  }
  return best;
}

/** So NGAY ke tu lan gan nhat co story_signature = sig. Infinity neu chua tung. */
function daysSinceSignature(country, sig, now = nowMs()) {
  return daysSinceField(country, 'story_signature', sig, now);
}

/** N ban ghi gan nhat cua 1 nuoc trong `withinDays` ngay (moi nhat truoc). */
function recentWithinDays(country, withinDays, now = nowMs()) {
  return entriesOfCountry(country).filter((e) => entryDays(e, now) <= withinDays).reverse();
}

/** Ty le bai gan nhat (toi da `n`) thoa 1 predicate tren combo. Tra {rate, n}. */
function rateRecent(country, n, predicate) {
  const list = recentByCountry(country, n);
  if (!list.length) return { rate: 0, n: 0 };
  let hit = 0;
  for (const e of list) { try { if (predicate(e.combo || {})) hit++; } catch (_) {} }
  return { rate: hit / list.length, n: list.length };
}

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

  // 3) conflict (case tu cay ngach) khong lap trong 20 bai gan nhat CUNG NGACH
  if (combo.conflict) {
    const hitC = recent.find((e) => e.combo && e.combo.conflict === combo.conflict);
    if (hitC) {
      return { dup: true, reason: `case conflict đã dùng trong ${COMBO_WINDOW} bài gần nhất của ngách này` };
    }
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

// ---- LOP DAU VAO category/subcategory: cooldown theo PAGE (moi nhat truoc) ----
function recentByPage(country, pageId, n) {
  const c = String(country || '').toUpperCase();
  const p = String(pageId || '');
  const list = readDb().entries.filter((e) => String(e.country || '').toUpperCase() === c
    && e.combo && String(e.combo.page_profile_id || '') === p);
  return list.slice(-Math.max(0, n)).reverse();
}
// Subcategory da dung trong n bai gan nhat cua page chua?
function subcategoryUsedRecently(country, pageId, subId, n) {
  if (!subId) return false;
  return recentByPage(country, pageId, n).some((e) => e.combo.subcategory_id === subId);
}
// So bai LIEN TIEP gan nhat cua page cung 1 category (de ap max_consecutive)
function categoryStreak(country, pageId, catId) {
  if (!catId) return 0;
  const recent = recentByPage(country, pageId, 20); // moi nhat truoc
  let s = 0;
  for (const e of recent) { if (e.combo.category_id === catId) s++; else break; }
  return s;
}
// Dem so lan dung 1 truong trong n bai gan nhat cua page (de chon least-used)
function usageCountByPage(country, pageId, field, value, n = 50) {
  return recentByPage(country, pageId, n).filter((e) => e.combo[field] === value).length;
}

/**
 * MIGRATE khoa 'niche': truoc day luu ten ngach A-E ("Mẹ già – con bạc bẽo"),
 * tu v1.10.2 doi sang category_id ("CAT01") de cooldown tinh RIENG theo category.
 *
 * Cach an toan: BACKFILL tu chinh du lieu da co — ban ghi nao da co combo.category_id
 * (bai tu v1.9.0 tro di) thi gan lai niche = category_id. Ban ghi cu hon khong co
 * category_id -> giu nguyen, se tu het han theo cooldown. Idempotent: chay lai khong doi gi.
 * @returns {migrated, skipped}
 */
function migrateNicheKeys() {
  let migrated = 0, skipped = 0;
  try {
    const db = readDb();
    for (const e of db.entries) {
      const cid = e.combo && e.combo.category_id;
      if (cid && e.niche !== cid) { e.niche = cid; migrated++; }
      else if (!cid) skipped++;
    }
    if (migrated) writeDb(db);
  } catch (_) { /* migrate hong khong duoc lam sap app */ }
  return { migrated, skipped };
}

module.exports = {
  all, recentByCountry, recentByCountryNiche, isDuplicate, add, stats, migrateNicheKeys,
  daysSinceField, daysSinceSignature, recentWithinDays, rateRecent,
  recentByPage, subcategoryUsedRecently, categoryStreak, usageCountByPage,
  HERO_WINDOW, COMBO_WINDOW, FILE,
};
