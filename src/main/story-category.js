'use strict';

/**
 * LOP DAU VAO category / subcategory — NAM TREN Story DNA Engine v1.8.1.
 * KHONG thay the engine: chi chon page -> category -> subcategory -> tap conflict ung vien,
 * roi chuyen xuong engine cu (pickCombo) nhu binh thuong.
 *
 * THU TU UU TIEN CUNG khi mau thuan (theo _meta file 1):
 *   hard compatibility (geo/season/gender) > family cooldown + daily cap v1.8.1
 *   > conflict fidelity > page profile constraints > subcategory affinity > weighted random
 *
 * CACH CHON BAT BUOC:
 *   eligible = all_candidates − incompatible − cooldown_blocked − daily_cap_blocked
 *   RỒI MỚI cộng trọng số affinity TRONG tập còn hợp lệ.
 *   TUYET DOI khong chon theo affinity truoc roi co nhet xuong.
 *   reveal_affinity / justice_affinity chi la GOI Y — cooldown v1.8.1 luon THANG affinity.
 *
 * FALLBACK (khong bao gio null, khong crash, khong de AI tu phat minh):
 *   het ung vien hop le -> chon cai LEAST-USED con hop le trong category.
 */

const memory = require('./story-memory');

let CATS = { categories: [] }, PAGES = { pages: [] }, MAP = { subcategory_map: {} };
try { CATS = require('./story-categories-us55.json'); } catch (_) {}
try { PAGES = require('./story-page-profiles-us55.json'); } catch (_) {}
try { MAP = require('./story-category-conflict-map-us55.json'); } catch (_) {}

const DEFAULT_COUNTRY = 'US';
const DEFAULT_MAX_CONSECUTIVE = 3;
const DEFAULT_SUBCAT_COOLDOWN = 20;

// ---------------- tra cuu ----------------
function allCategories() { return (CATS.categories || []).filter((c) => c.status === 'active'); }
function categoryById(id) { return (CATS.categories || []).find((c) => c.category_id === id) || null; }
function allPages() { return (PAGES.pages || []).filter((p) => p.status !== 'inactive'); }
function pageById(id) { return (PAGES.pages || []).find((p) => p.page_profile_id === id) || null; }
function subcatsOf(catId) {
  const c = categoryById(catId);
  return ((c && c.subcategories) || []).filter((s) => s.status === 'active');
}
function subcatById(subId) {
  for (const c of (CATS.categories || [])) {
    const s = (c.subcategories || []).find((x) => x.subcategory_id === subId);
    if (s) return s;
  }
  return null;
}
function mapOf(subId) { return (MAP.subcategory_map || {})[subId] || null; }
function statusDynamics() { return MAP.status_dynamics || []; }
function legacyThemeCategories(theme) { return (MAP.legacy_theme_to_categories || {})[theme] || []; }
// Nguoc lai: category nay chay duoc voi nhung legacy_theme nao (tru E - E la status_dynamic)
function legacyThemesForCategory(catId) {
  const m = MAP.legacy_theme_to_categories || {};
  const out = [];
  for (const [theme, cats] of Object.entries(m)) {
    if (theme === 'E_ngheo_vs_giau') continue;
    if (Array.isArray(cats) && cats.includes(catId)) out.push(theme);
  }
  return out;
}

// ---------------- weighted random trong TAP DA HOP LE ----------------
function weightedPick(items, weightOf) {
  const ws = items.map((it) => Math.max(0, Number(weightOf(it)) || 0));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)] || null;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

/**
 * Chon CATEGORY cho 1 page.
 * eligible = category active ∩ co trong page_weights − vuot max_consecutive
 * roi moi weighted random theo page_weights (× base_weight nhe).
 */
function chooseCategory(country, page, manualCategoryId) {
  if (manualCategoryId) {
    const c = categoryById(manualCategoryId);
    if (c && c.status === 'active') return { category: c, forced: true, reason: 'manual override' };
  }
  const weights = (page && page.category_weights) || {};
  const maxCons = (page && page.max_consecutive_same_category) || DEFAULT_MAX_CONSECUTIVE;

  let candidates = allCategories().filter((c) => weights[c.category_id] > 0);
  if (!candidates.length) candidates = allCategories();          // page khong khai bao -> lay tat ca

  // loai category dang vuot chuoi lien tiep (R-03 / max_consecutive)
  const eligible = candidates.filter((c) => {
    const cc = c.max_consecutive || maxCons;
    return memory.categoryStreak(country, page ? page.page_profile_id : '', c.category_id) < cc;
  });
  const pool = eligible.length ? eligible : candidates;           // fallback: khong de rong
  const cat = weightedPick(pool, (c) => (weights[c.category_id] || c.base_weight || 1));
  return { category: cat, forced: false, reason: eligible.length ? '' : 'moi category deu cham tran streak' };
}

/**
 * Chon SUBCATEGORY trong category.
 * eligible = active − dang cooldown (20 bai gan nhat cua page); roi weighted theo base_weight.
 * Het eligible -> LEAST-USED trong category (fallback, khong null).
 */
function chooseSubcategory(country, page, category, manualSubcategoryId) {
  const pageId = page ? page.page_profile_id : '';
  const cooldown = (page && page.subcategory_cooldown_window) || DEFAULT_SUBCAT_COOLDOWN;
  const subs = subcatsOf(category.category_id);
  if (!subs.length) return { subcategory: null, fallback: true, reason: 'category khong co subcategory active' };

  if (manualSubcategoryId) {
    const s = subs.find((x) => x.subcategory_id === manualSubcategoryId);
    if (s) return { subcategory: s, forced: true, reason: 'manual override' };
  }

  const eligible = subs.filter((s) => {
    const win = s.cooldown_window || cooldown;
    return !memory.subcategoryUsedRecently(country, pageId, s.subcategory_id, win);
  });
  if (eligible.length) {
    return { subcategory: weightedPick(eligible, (s) => s.base_weight || 1), fallback: false, reason: '' };
  }
  // FALLBACK (khong bao gio null): LEAST-RECENTLY-USED -> gian cach TOI DA co the.
  // Luu y: neu category chi co 8 subcategory ma cua so cooldown la 20 thi VE MAT TOAN HOC
  // khong the khong lap; ta chon cai lau khong dung nhat (va it dung nhat) de gian toi da.
  const recent = memory.recentByPage(country, pageId, 100);   // moi nhat truoc
  let best = subs[0], bestKey = null;
  for (const s of subs) {
    let dist = recent.findIndex((e) => e.combo.subcategory_id === s.subcategory_id);
    if (dist < 0) dist = Infinity;                            // chua dung bao gio
    const used = memory.usageCountByPage(country, pageId, 'subcategory_id', s.subcategory_id, 100);
    const key = [dist === Infinity ? Number.MAX_SAFE_INTEGER : dist, -used];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { bestKey = key; best = s; }
  }
  return { subcategory: best, fallback: true, reason: 'mọi subcategory đang cooldown — lấy least-recently-used' };
}

/**
 * Tap CONFLICT ung vien cho subcategory (id trong catalog cu).
 * Rong -> tra [] de engine tu chon trong theme (fallback cap category).
 */
function conflictIdsFor(subId) {
  const m = mapOf(subId);
  return (m && Array.isArray(m.conflict_ids)) ? m.conflict_ids.slice() : [];
}
// Gop conflict_ids cua CA category (fallback khi subcategory qua it)
function conflictIdsForCategory(catId) {
  const out = new Set();
  for (const s of subcatsOf(catId)) for (const id of conflictIdsFor(s.subcategory_id)) out.add(id);
  return [...out];
}

/**
 * CHON DAU VAO hoan chinh. Luon tra ve doi tuong hop le (khong null).
 * @returns {page_profile_id, category_id, category_name, subcategory_id, subcategory_name,
 *           conflict_premise, conflict_ids, legacy_themes, status_dynamic, reveal_affinity,
 *           justice_affinity, fallback, notes[]}
 */
function chooseInput({ country = DEFAULT_COUNTRY, pageId = '', categoryId = '', subcategoryId = '' } = {}) {
  const notes = [];
  const page = pageById(pageId) || allPages()[0] || null;

  // manual subcategory -> suy ra category cua no
  let cat = null, sub = null, forced = false;
  if (subcategoryId) {
    const s = subcatById(subcategoryId);
    if (s && s.status === 'active') {
      sub = s; cat = categoryById(s.category_id); forced = true;
      notes.push('manual subcategory');
    }
  }
  if (!cat) {
    const cr = chooseCategory(country, page, categoryId);
    cat = cr.category; if (cr.forced) forced = true;
    if (cr.reason) notes.push(cr.reason);
  }
  if (!cat) cat = allCategories()[0];
  if (!sub) {
    const sr = chooseSubcategory(country, page, cat, subcategoryId);
    sub = sr.subcategory; if (sr.forced) forced = true;
    if (sr.reason) notes.push(sr.reason);
  }
  if (!sub) sub = subcatsOf(cat.category_id)[0] || null;

  const m = sub ? mapOf(sub.subcategory_id) : null;
  let ids = sub ? conflictIdsFor(sub.subcategory_id) : [];
  if (ids.length < 3) {                                   // PHASE 6: it qua -> mo rong cap category
    const catIds = conflictIdsForCategory(cat.category_id);
    if (catIds.length > ids.length) { ids = catIds; notes.push('conflict mở rộng cấp category'); }
  }

  // PHASE 3: legacy_theme + status_dynamic
  const legacy = (sub && sub.legacy_themes) || (m && m.legacy_themes) || [];
  let nonE = legacy.filter((t) => t !== 'E_ngheo_vs_giau');
  // Subcategory khong khai legacy_themes -> suy tu legacy_theme_to_categories (data co san),
  // KHONG de rong vi theme rong -> catalog rong -> conflict rong.
  if (!nonE.length) nonE = legacyThemesForCategory(cat ? cat.category_id : '');
  if (!nonE.length) nonE = ['A_me_gia'];                  // mac dinh trung tinh, co trong catalog
  const legacy_theme = nonE[Math.floor(Math.random() * nonE.length)];
  const status_dynamic = legacy.includes('E_ngheo_vs_giau')
    ? (statusDynamics()[Math.floor(Math.random() * statusDynamics().length)] || '') : '';

  return {
    page_profile_id: page ? page.page_profile_id : '',
    category_id: cat ? cat.category_id : '',
    category_name: cat ? (cat.name_en || cat.name_vi || '') : '',
    subcategory_id: sub ? sub.subcategory_id : '',
    subcategory_name: sub ? (sub.name_en || '') : '',
    conflict_premise: sub ? (sub.conflict_premise || '') : '',
    conflict_ids: ids,
    legacy_theme,
    status_dynamic,
    reveal_affinity: (sub && sub.reveal_affinity) || (m && m.reveal_affinity) || [],
    justice_affinity: (sub && sub.justice_affinity) || (m && m.justice_affinity) || [],
    forced,
    notes,
  };
}

module.exports = {
  chooseInput, chooseCategory, chooseSubcategory,
  allCategories, categoryById, allPages, pageById, subcatsOf, subcatById,
  conflictIdsFor, conflictIdsForCategory, statusDynamics, legacyThemeCategories,
  DEFAULT_COUNTRY,
};
