'use strict';

/**
 * STORY DNA — App gan to hop truoc, AI chi ke chuyen (chong trung lap).
 *
 * DA QUOC GIA ngay tu dau: pool long theo ma nuoc (US/ES/CA...). Them nuoc moi
 * chi can them pool, KHONG sua code.
 *
 * Pool MAC DINH: story-dna-pool.json (dong goi kem app -> chi doc, nam trong asar).
 * Pool NGUOI DUNG sua: luu vao userData qua store ('dna-pools.json') -> ghi duoc.
 * Pool hieu luc cua 1 nuoc = pool nguoi dung (neu co) > pool mac dinh.
 */

const store = require('./store');
const memory = require('./story-memory');
const conflictTree = require('./conflict-tree');
const nameGender = require('./name-gender');

let BUNDLED = {};
try { BUNDLED = require('./story-dna-pool.json'); } catch (_) { BUNDLED = {}; }

// 12 TRUC DNA (thu tu + nhan hien thi). key = ten truc trong pool.
const AXES = [
  { key: 'opening_scene', label: 'Bối cảnh mở màn (opening_scene)' },
  { key: 'hero_name', label: 'Tên nhân vật chính (hero_name)' },
  { key: 'villain_type', label: 'Kiểu nhân vật phản diện (villain_type)' },
  { key: 'villain_name', label: 'Tên phản diện — con/cháu (villain_name)' },
  { key: 'relationship', label: 'Quan hệ (relationship)' },
  { key: 'occupation', label: 'Nghề nghiệp (occupation)' },
  { key: 'location', label: 'Địa điểm (location)' },
  { key: 'icon_object', label: 'Vật biểu tượng (icon_object)' },
  { key: 'humiliation_type', label: 'Kiểu bị hạ nhục (humiliation_type)' },
  { key: 'twist', label: 'Nút lật (twist)' },
  { key: 'justice_type', label: 'Kiểu công lý (justice_type)' },
  { key: 'ending', label: 'Kết (ending)' },
  { key: 'dominant_emotion', label: 'Cảm xúc chủ đạo (dominant_emotion)' },
];
const AXIS_KEYS = AXES.map((a) => a.key);
const DEFAULT_COUNTRY = 'US';

const DNA_FILE = 'dna-pools.json'; // pool nguoi dung sua (userData)

function readUserPools() {
  try { const p = store.read(DNA_FILE); return (p && typeof p === 'object') ? p : {}; }
  catch (_) { return {}; }
}
function writeUserPools(p) { try { store.write(DNA_FILE, p || {}); } catch (_) {} }

// 1 pool coi la "co noi dung" neu co it nhat 1 truc khong rong
function poolHasContent(pool) {
  return !!pool && AXIS_KEYS.some((k) => Array.isArray(pool[k]) && pool[k].length);
}

// Danh sach ma quoc gia (union pool mac dinh + pool nguoi dung), US truoc
function listCountries() {
  const set = new Set([DEFAULT_COUNTRY, ...Object.keys(BUNDLED), ...Object.keys(readUserPools())]);
  return [DEFAULT_COUNTRY, ...[...set].filter((c) => c !== DEFAULT_COUNTRY).sort()];
}

// Pool hieu luc cua 1 nuoc (dam bao du 12 truc, moi truc la mang)
function getPool(country) {
  const c = String(country || DEFAULT_COUNTRY).toUpperCase();
  const user = readUserPools()[c];
  const base = poolHasContent(user) ? user : (BUNDLED[c] || {});
  const out = {};
  for (const k of AXIS_KEYS) out[k] = Array.isArray(base[k]) ? base[k].slice() : [];
  return out;
}

// Luu pool nguoi dung cho 1 nuoc (tu man Cai dat)
function savePool(country, pool) {
  const c = String(country || '').toUpperCase();
  if (!c) return { ok: false, error: 'Thiếu mã quốc gia' };
  const clean = {};
  for (const k of AXIS_KEYS) {
    const v = pool && pool[k];
    clean[k] = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
  }
  const all = readUserPools();
  all[c] = clean;
  writeUserPools(all);
  return { ok: true };
}

function pickOne(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------- VALIDATE TUONG THICH DNA (truoc khi goi AI) ----------------
// Tu vai (chuoi mo ta) suy ra gioi: 'F' | 'M' | 'U' (luong tinh/khong ro/mau thuan).
const ROLE_FEMALE = /\b(mother|grandmother|grandma|bride|wife|widow(?!er)|aunt|sister|daughter|granddaughter|niece|daughter-in-law|mother-in-law|fiancee)\b/i;
const ROLE_MALE = /\b(father|grandfather|grandpa|husband|widower|uncle|brother|son|grandson|nephew|son-in-law|father-in-law)\b/i;
function roleGender(phrase) {
  const f = ROLE_FEMALE.test(phrase), m = ROLE_MALE.test(phrase);
  if (f && m) return 'U';   // mau thuan (vd "grandson's fiancee") -> khong rang buoc
  if (f) return 'F';
  if (m) return 'M';
  return 'U';
}

// Quan he co hop NGACH khong (theme <-> relationship).
const NICHE_REL = {
  A: { inc: /\b(mother|elderly parent|grandparent|grandmother|stepparent)\b/i, exc: /\b(father|bride|veteran|widow|widower|boss|employee|sibling)\b/i },
  B: { inc: /\bveteran\b/i, exc: null },
  C: { inc: /\b(bride|mother-in-law|father-in-law|new husband)\b/i, exc: null },
  D: { inc: /\b(widow|widower|spouse)\b/i, exc: null },
  E: { inc: /\b(sibling|aunt|uncle|niece|nephew|grandparent|grandchild|parent|in-law|relative|family|stepparent|stepchild)\b/i, exc: /\b(veteran|bride)\b/i },
};
function nicheRelationshipOk(code, rel) {
  const r = NICHE_REL[String(code || '').toUpperCase()];
  if (!r) return true;                       // ngach la / khong co ma -> khong rang buoc theme
  if (r.exc && r.exc.test(rel)) return false;
  return r.inc.test(rel);
}

/**
 * Kiem tra 1 to hop DNA co TUONG THICH khong (truoc khi cho AI viet):
 *  1) relationship khop theme (ngach).
 *  2) villain_type khong mau thuan gioi voi vai phan dien trong relationship.
 *  3) hero_name khop gioi vai chinh (neu vai ro gioi) - tranh ten luong tinh.
 *  4) villain_name khop gioi vai phan dien (neu ro gioi) - tranh ten luong tinh.
 * @returns {ok:boolean, reason:string}
 */
function validateCombo(combo, nicheCode) {
  const rel = String(combo.relationship || '');
  if (!nicheRelationshipOk(nicheCode, rel)) {
    return { ok: false, reason: `relationship "${rel}" không hợp ngách ${nicheCode}` };
  }
  const parts = rel.split(/\s+and\s+/i);
  const heroPart = parts[0] || '';
  const villainPart = parts.slice(1).join(' and ') || '';

  const heroG = roleGender(heroPart);
  const relVG = roleGender(villainPart);
  const typeVG = roleGender(String(combo.villain_type || ''));

  // 2) villain_type mau thuan gioi voi relationship villain
  if (relVG !== 'U' && typeVG !== 'U' && relVG !== typeVG) {
    return { ok: false, reason: `villain_type (${typeVG}) mâu thuẫn vai phản diện trong relationship (${relVG})` };
  }
  const villainG = relVG !== 'U' ? relVG : typeVG;

  // 3) hero_name khop gioi vai chinh
  if (heroG !== 'U') {
    const g = nameGender.gender(combo.hero_name);
    if (g !== heroG) return { ok: false, reason: `hero_name "${combo.hero_name}" (${g}) không khớp vai "${heroPart.trim()}" (${heroG})` };
  }
  // 4) villain_name khop gioi vai phan dien
  if (villainG !== 'U') {
    const g = nameGender.gender(combo.villain_name);
    if (g !== villainG) return { ok: false, reason: `villain_name "${combo.villain_name}" (${g}) không khớp vai phản diện (${villainG})` };
  }
  return { ok: true, reason: '' };
}

// Random 1 to hop day du 12 truc tu pool 1 nuoc
function randomCombo(pool) {
  const combo = {};
  for (const k of AXIS_KEYS) combo[k] = pickOne(pool[k]);
  return combo;
}

// Gan conflict (case tu cay ngach) vao 1 combo. nicheCode = A/B/C/D/E.
// Ngach khong co trong cay -> combo.conflict = '' (fallback humiliation_type o prompt).
function attachConflict(combo, country, nicheCode) {
  const c = { ...combo };
  let conflictBranch = '';
  if (nicheCode) {
    const pc = conflictTree.pickConflict(country, nicheCode);
    if (pc) { c.conflict = pc.text; conflictBranch = pc.branch; }
  }
  if (c.conflict === undefined) c.conflict = '';
  return { combo: c, conflictBranch };
}

/**
 * Chon 1 to hop DA LOC TRUNG cho (country, niche). Neu co nicheCode thi random
 * them 1 case conflict TU DUNG cay ngach do (loc trung ca conflict).
 * Random toi khi khong dung so chong trung; het luot thi chot cai cuoi (fellBack=true).
 * @returns {{combo, country, tries, fellBack, poolEmpty, lastReason, conflictBranch, hasConflict}}
 */
function pickCombo(country, niche, nicheCode, { maxTries = 800 } = {}) {
  const c = String(country || DEFAULT_COUNTRY).toUpperCase();
  const pool = getPool(c);
  const poolEmpty = !poolHasContent(pool);

  const make = () => attachConflict(randomCombo(pool), c, nicheCode);
  let r = make();
  let combo = r.combo;
  let conflictBranch = r.conflictBranch;
  let tries = 1;
  let regen = 0;         // so lan random lai vi KHONG TUONG THICH (khong tinh trung lap)
  let lastReason = '';

  if (poolEmpty) return { combo, country: c, tries, regen, fellBack: false, poolEmpty, lastReason: 'Pool rỗng', conflictBranch, hasConflict: !!combo.conflict };

  // Xau: KHONG tuong thich HOAC trung lap -> random lai.
  // Kiem tra tuong thich TRUOC (khong doc file) de reject nhanh; hop le moi soi so chong trung (doc file).
  const isBad = (cmb) => {
    const v = validateCombo(cmb, nicheCode);
    if (!v.ok) return { bad: true, reason: v.reason, invalid: true };
    const d = memory.isDuplicate(cmb, c, niche);
    if (d.dup) return { bad: true, reason: d.reason, invalid: false };
    return { bad: false };
  };

  let check = isBad(combo);
  while (check.bad && tries < maxTries) {
    lastReason = check.reason;
    if (check.invalid) regen++;
    r = make();
    combo = r.combo; conflictBranch = r.conflictBranch;
    tries++;
    check = isBad(combo);
  }
  const fellBack = check.bad;   // sau maxTries van xau -> danh phai chot
  if (fellBack) lastReason = check.reason;
  return { combo, country: c, tries, regen, fellBack, poolEmpty, lastReason, conflictBranch, hasConflict: !!combo.conflict, valid: !check.bad };
}

/**
 * Khoi text BAT BUOC nhet vao DAU prompt de skill ke xoay quanh dung to hop.
 */
function buildDnaBlock(combo, country) {
  const g = (k) => (combo && combo[k]) ? combo[k] : '(bất kỳ)';
  const lines = [
    `[STORY DNA — quốc gia ${String(country || DEFAULT_COUNTRY).toUpperCase()}]`,
    'BẮT BUỘC dùng ĐÚNG các yếu tố sau (không đổi tên nhân vật, không đổi vật biểu tượng):',
    `- hero_name = ${g('hero_name')}`,
    `- occupation = ${g('occupation')}`,
    `- location = ${g('location')}`,
    `- relationship = ${g('relationship')}`,
    `- opening_scene = ${g('opening_scene')}`,
    `- villain = ${g('villain_type')}`,
    `- villain_name = ${g('villain_name')}`,
    `- humiliation = ${g('humiliation_type')}`,
    `- icon_object = ${g('icon_object')}`,
    `- twist = ${g('twist')}`,
    `- justice = ${g('justice_type')}`,
    `- ending = ${g('ending')}`,
    `- emotion = ${g('dominant_emotion')}`,
  ];
  if (combo && combo.conflict) {
    lines.push(`- conflict = ${combo.conflict}`);
    lines.push('  (BẮT BUỘC kể câu chuyện đúng theo tình huống conflict này của ngách.)');
  }
  lines.push('Skill kể câu chuyện xoay quanh đúng tổ hợp này. Giữ nguyên toàn bộ khuôn xuất ===...=== như hướng dẫn bên dưới.');
  lines.push('');
  return lines.join('\n');
}

// Chuyen to hop -> JSON GON, du truc, ten ro rang de ghi cot 22 story_dna_combo.
// theme = ten ngach (page target). conflict_id = case conflict da chon.
function comboToSheetJson(combo, country, theme) {
  const c = combo || {};
  return JSON.stringify({
    country: String(country || DEFAULT_COUNTRY).toUpperCase(),
    theme: theme || '',
    conflict_id: c.conflict || '',
    hero_name: c.hero_name || '',
    villain_name: c.villain_name || '',
    occupation: c.occupation || '',
    location: c.location || '',
    icon_object: c.icon_object || '',
    opening_scene: c.opening_scene || '',
    relationship: c.relationship || '',
    humiliation: c.humiliation_type || '',
    twist: c.twist || '',
    justice: c.justice_type || '',
    ending: c.ending || '',
    emotion: c.dominant_emotion || '',
  });
}

// Ghi so 1 bai da chot to hop (goi sau khi bai viet thanh cong)
function remember({ storyId, country, niche, combo }) {
  memory.add({ storyId, country, niche, combo });
}

module.exports = {
  AXES, AXIS_KEYS, DEFAULT_COUNTRY,
  listCountries, getPool, savePool,
  randomCombo, pickCombo, buildDnaBlock, remember, comboToSheetJson,
  validateCombo, roleGender, nicheRelationshipOk,
};
