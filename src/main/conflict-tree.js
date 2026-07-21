'use strict';

/**
 * CAY CONFLICT theo NGACH (da quoc gia). Khi viet 1 bai, engine random 1 "case"
 * conflict TU DUNG cay cua ngach dang chon (A random trong A_me_gia, B trong
 * B_veteran...) -> khong random lung tung giua cac ngach.
 *
 * Cau truc: { US: { A_me_gia: { A1_...: [..], A2_...: [..] }, B_veteran: { B_cases: [..] }, ... } }
 *
 * Nhanh ngach nhan dien theo MA NGACH = ky tu dau ten nhanh (A_me_gia -> 'A').
 *
 * Cach ghep 1 case tu 1 nhanh:
 *  - nhanh co 1 mang           -> random 1 muc (vd B_veteran).
 *  - nhieu mang, ten dang So (A1_, A2_) = cac NHOM thay the -> gop het, random 1 muc.
 *  - nhieu mang ten NGU NGHIA (C_villain_source + C_situation) = cac truc BO TRO
 *    -> random 1 muc MOI mang roi ghep lai (who + what).
 *
 * Pool nguoi dung sua luu userData ('conflict-tree.json'); mac dinh dong goi kem app.
 */

const store = require('./store');

// Nap tu file v2 per-country (story-conflict-tree-<C>.json). Chi lay CAC NHANH ngach
// (key dang A_me_gia/B_veteran...) cho man Cai dat; bo qua conflict_catalog/selection_policy.
const COUNTRIES = ['US', 'ES', 'CA'];
let BUNDLED = {};
for (const c of COUNTRIES) {
  let raw = null;
  try { raw = require('./story-conflict-tree-' + c + '.json'); } catch (_) { raw = null; }
  if (raw && typeof raw === 'object') {
    const branches = {};
    for (const k of Object.keys(raw)) {
      if (/^[A-Z]_/.test(k) && raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k])) branches[k] = raw[k];
    }
    if (Object.keys(branches).length) BUNDLED[c] = branches;
  }
}

const FILE = 'conflict-tree.json'; // ban nguoi dung sua (userData)
const DEFAULT_COUNTRY = 'US';

function readUser() {
  try { const t = store.read(FILE); return (t && typeof t === 'object') ? t : {}; }
  catch (_) { return {}; }
}
function writeUser(t) { try { store.write(FILE, t || {}); } catch (_) {} }

function treeHasContent(countryTree) {
  return !!countryTree && Object.keys(countryTree).length > 0
    && Object.values(countryTree).some((branch) => branch && Object.values(branch).some((a) => Array.isArray(a) && a.length));
}

// Cay hieu luc cua 1 nuoc (nguoi dung > mac dinh)
function getCountryTree(country) {
  const c = String(country || DEFAULT_COUNTRY).toUpperCase();
  const user = readUser()[c];
  if (treeHasContent(user)) return user;
  return BUNDLED[c] || {};
}

function listCountries() {
  const set = new Set([DEFAULT_COUNTRY, ...Object.keys(BUNDLED), ...Object.keys(readUser())]);
  return [DEFAULT_COUNTRY, ...[...set].filter((c) => c !== DEFAULT_COUNTRY).sort()];
}

// Cac ten nhanh (ngach) cua 1 nuoc, vd ['A_me_gia','B_veteran',...]
function listBranches(country) {
  return Object.keys(getCountryTree(country));
}

// Ma ngach cua 1 ten nhanh: 'A_me_gia' -> 'A'
function branchCode(branchName) {
  return String(branchName || '').split('_')[0].toUpperCase();
}

// Tim nhanh ngach theo MA NGACH (A/B/C/D/E). Tra ve {name, branch} hoac null.
function getBranchForNiche(country, nicheCode) {
  const code = String(nicheCode || '').toUpperCase();
  if (!code) return null;
  const tree = getCountryTree(country);
  for (const name of Object.keys(tree)) {
    if (branchCode(name) === code) return { name, branch: tree[name] };
  }
  return null;
}

function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Cac ten mang trong nhanh co phai kieu "nhom thay the" (A1_, A2_) khong?
function isNumberedGroups(keys) {
  return keys.length > 1 && keys.every((k) => /^[A-Za-z]\d/.test(k));
}

/**
 * Random 1 case conflict tu 1 nhanh (branch). Tra ve chuoi mo ta conflict, hoac '' neu rong.
 */
function composeConflict(branch) {
  if (!branch || typeof branch !== 'object') return '';
  const arrays = Object.entries(branch).filter(([, v]) => Array.isArray(v) && v.length);
  if (!arrays.length) return '';
  if (arrays.length === 1) return String(pickOne(arrays[0][1]));

  const keys = arrays.map(([k]) => k);
  if (isNumberedGroups(keys)) {
    // cac nhom thay the (A1..A5) -> gop het roi random 1
    const flat = arrays.reduce((acc, [, v]) => acc.concat(v), []);
    return String(pickOne(flat));
  }
  // cac truc bo tro -> random 1 moi mang roi ghep (who + what)
  return arrays.map(([, v]) => String(pickOne(v))).join('. ');
}

/**
 * Random conflict cho (country, nicheCode). Tra ve { text, branch } | null neu ngach
 * khong co trong cay (de luong goi fallback humiliation_type).
 */
function pickConflict(country, nicheCode) {
  const found = getBranchForNiche(country, nicheCode);
  if (!found) return null;
  const text = composeConflict(found.branch);
  if (!text) return null;
  return { text, branch: found.name };
}

// ---- Cho man Cai dat: doc/luu cay theo nuoc ----
function getTree(country) { return getCountryTree(country); }
function saveTree(country, countryTree) {
  const c = String(country || '').toUpperCase();
  if (!c) return { ok: false, error: 'Thiếu mã quốc gia' };
  if (!countryTree || typeof countryTree !== 'object') return { ok: false, error: 'Dữ liệu cây không hợp lệ' };
  const all = readUser();
  all[c] = countryTree;
  writeUser(all);
  return { ok: true };
}

// Doc 1 nhanh (ngach) -> object {subKey: [..]}
function getBranch(country, branchName) {
  const t = getCountryTree(country);
  return t[branchName] || {};
}
// Luu 1 nhanh: ghi de len ban nguoi dung, giu nguyen cac nhanh khac
function saveBranch(country, branchName, data) {
  const c = String(country || '').toUpperCase();
  if (!c || !branchName) return { ok: false, error: 'Thiếu quốc gia hoặc tên ngách' };
  if (!data || typeof data !== 'object') return { ok: false, error: 'Dữ liệu không hợp lệ' };
  const cur = Object.assign({}, getCountryTree(c)); // bat dau tu cay hieu luc -> khong mat nhanh khac
  const clean = {};
  for (const k of Object.keys(data)) {
    clean[k] = Array.isArray(data[k]) ? data[k].map((s) => String(s).trim()).filter(Boolean) : [];
  }
  cur[branchName] = clean;
  return saveTree(c, cur);
}

module.exports = {
  DEFAULT_COUNTRY, FILE,
  listCountries, listBranches, getBranchForNiche, branchCode,
  composeConflict, pickConflict, getTree, saveTree, getBranch, saveBranch,
};
