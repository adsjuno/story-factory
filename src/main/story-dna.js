'use strict';

/**
 * STORY DNA ENGINE v2 (US) — App gan blueprint TRUOC, AI chi ke.
 *
 * Du lieu (per country): story-dna-pool-<C>.json, story-conflict-tree-<C>.json,
 * story-engine-config-<C>.json. US day du; ES/CA rong (khong co file -> pool rong).
 *
 * Chon theo generation_order (17 buoc) + weighted_random (affinity x2.5, soft x0.25,
 * hard x0.0, underused x1.5) + theme_affinity + compatibility_rules + plot_rules
 * (chong "general lap": gioi han ty le authority-rescue / hidden-wealth / reconciliation)
 * + dedup THEO NGAY + story_signature (khong lap 365 ngay).
 */

const crypto = require('crypto');
const store = require('./store');
const memory = require('./story-memory');

const DEFAULT_COUNTRY = 'US';
const COUNTRIES = ['US', 'ES', 'CA'];

// 13 truc hien thi/sua trong Cai dat (giu tuong thich UI cu)
const AXES = [
  { key: 'opening_scene', label: 'Bối cảnh mở màn (opening_scene)' },
  { key: 'hero_name', label: 'Tên nhân vật chính (hero_name)' },
  { key: 'villain_type', label: 'Kiểu phản diện (villain_type)' },
  { key: 'villain_name', label: 'Tên phản diện (villain_name)' },
  { key: 'relationship', label: 'Quan hệ (relationship)' },
  { key: 'occupation', label: 'Nghề nghiệp (occupation)' },
  { key: 'location', label: 'Địa điểm (location)' },
  { key: 'icon_object', label: 'Vật biểu tượng (icon_object)' },
  { key: 'humiliation_type', label: 'Kiểu bị hạ nhục (humiliation_type)' },
  { key: 'twist', label: 'Nút lật / reveal (twist)' },
  { key: 'justice_type', label: 'Kiểu công lý (justice_type)' },
  { key: 'ending', label: 'Kết (ending)' },
  { key: 'dominant_emotion', label: 'Cảm xúc chủ đạo (dominant_emotion)' },
];
const AXIS_KEYS = AXES.map((a) => a.key);

// ---- Nap du lieu dong goi (bundled) + override nguoi dung (userData) ----
function bundled(name) { try { return require('./' + name); } catch (_) { return null; } }
const POOL_BUNDLED = {};
const CONFLICT_BUNDLED = {};
const CONFIG_BUNDLED = {};
for (const c of COUNTRIES) {
  POOL_BUNDLED[c] = bundled(`story-dna-pool-${c}.json`);
  CONFLICT_BUNDLED[c] = bundled(`story-conflict-tree-${c}.json`);
  CONFIG_BUNDLED[c] = bundled(`story-engine-config-${c}.json`);
}

const POOL_FILE = 'dna-pools.json'; // override nguoi dung sua trong Cai dat

function readUserPools() {
  try { const p = store.read(POOL_FILE); return (p && typeof p === 'object') ? p : {}; } catch (_) { return {}; }
}
function writeUserPools(p) { try { store.write(POOL_FILE, p || {}); } catch (_) {} }

// Ngach: ma quoc te (page_target VN) -> ma theme trong file
const NICHE_ALIASES = {
  A: 'A_me_gia', B: 'B_veteran', C: 'C_co_dau', D: 'D_vo_phan_boi', E: 'E_ngheo_vs_giau',
};
function themeCodeOf(nicheCode, nicheLabel) {
  const c = String(nicheCode || '').toUpperCase();
  if (NICHE_ALIASES[c]) return NICHE_ALIASES[c];
  // thu doan tu label tieng Viet
  const s = String(nicheLabel || '').toLowerCase();
  if (/mẹ già|me gia|con/.test(s)) return 'A_me_gia';
  if (/cựu|cuu|chiến|chien|veteran/.test(s)) return 'B_veteran';
  if (/dâu|dau|nhà chồng|nha chong/.test(s)) return 'C_co_dau';
  if (/phản bội|phan boi|vợ|vo /.test(s)) return 'D_vo_phan_boi';
  if (/nghèo|ngheo|giàu|giau/.test(s)) return 'E_ngheo_vs_giau';
  return '';
}

// ---- POOL (13 truc) hieu luc: user override > bundled ----
function poolAxes(country) {
  const c = String(country || DEFAULT_COUNTRY).toUpperCase();
  const user = readUserPools()[c];
  const base = POOL_BUNDLED[c] || {};
  const out = {};
  for (const k of AXIS_KEYS) {
    const uv = user && Array.isArray(user[k]) && user[k].length ? user[k] : null;
    out[k] = uv || (Array.isArray(base[k]) ? base[k].slice() : []);
  }
  return out;
}
function poolHasContent(pool) { return AXIS_KEYS.some((k) => Array.isArray(pool[k]) && pool[k].length); }
function getPool(country) { return poolAxes(country); }

function savePool(country, pool) {
  const c = String(country || '').toUpperCase();
  if (!c) return { ok: false, error: 'Thiếu mã quốc gia' };
  const clean = {};
  for (const k of AXIS_KEYS) {
    const v = pool && pool[k];
    clean[k] = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
  }
  const all = readUserPools(); all[c] = clean; writeUserPools(all);
  return { ok: true };
}
function listCountries() { return COUNTRIES.slice(); }

// Cac phan CAU HINH engine (khong sua qua UI truc, lay tu bundled)
function poolExtra(country) { return POOL_BUNDLED[String(country || DEFAULT_COUNTRY).toUpperCase()] || {}; }
function conflictData(country) { return CONFLICT_BUNDLED[String(country || DEFAULT_COUNTRY).toUpperCase()] || {}; }
function engineConfig(country) { return CONFIG_BUNDLED[String(country || DEFAULT_COUNTRY).toUpperCase()] || {}; }

// ---------------- Weighted random ----------------
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function lc(x) { return String(x || '').toLowerCase(); }
function affinityMatch(item, keywords) {
  if (!keywords || !keywords.length) return false;
  const s = lc(item);
  return keywords.some((k) => s.includes(lc(k)));
}
function weightedRandom(items, weights) {
  let total = 0;
  for (const w of weights) total += (w > 0 ? w : 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (r < w) return items[i];
    r -= w;
  }
  return items[items.length - 1];
}

/**
 * Chon 1 gia tri tu `candidates` theo weighted_random.
 *  - affinity (item nam trong affinityKeywords) -> x affinity_match_multiplier
 *  - dung trong hardDays -> loai (weight 0)
 *  - dung trong softDays -> x recent_soft_penalty_multiplier
 *  - chua tung dung -> x underused_item_bonus_multiplier
 * exclude: mang gia tri bi cam (plot_rules / compatibility).
 */
function chooseWeighted(candidates, { country, field, affinityKeywords, hardDays, softDays, wr, exclude, affinityHard }) {
  let list = candidates.filter((x) => !(exclude && exclude.has(x)));
  if (!list.length) return null;
  // affinityHard: uu tien CUNG theo ngach (vd cuu binh -> chi icon quan doi, KHONG hop nau an).
  // Chi han che khi nhom affinity du da dang (>=3) de van co bien the.
  if (affinityHard && affinityKeywords && affinityKeywords.length) {
    const aff = list.filter((x) => affinityMatch(x, affinityKeywords));
    if (aff.length >= 3) list = aff;
  }
  const weights = list.map((item) => {
    const days = memory.daysSinceField(country, field, item);
    if (hardDays != null && days < hardDays) return 0;               // hard block
    let w = 1;
    if (affinityMatch(item, affinityKeywords)) w *= (wr.affinity_match_multiplier || 2.5);
    if (softDays != null && days < softDays) w *= (wr.recent_soft_penalty_multiplier != null ? wr.recent_soft_penalty_multiplier : 0.25);
    if (days === Infinity) w *= (wr.underused_item_bonus_multiplier || 1.5);
    return w;
  });
  const pick = weightedRandom(list, weights);
  if (pick != null) return pick;
  // tat ca bi hard-block -> noi long: bo hard block, chon uniform
  return pickOne(list);
}

// ---------------- Phan loai cho plot_rules ----------------
function isAuthorityRescueJustice(j) {
  return /authority figure|general, judge|powerful stranger the narrator once helped|someone the villain respects|someone powerful the victim once helped|only one who can save/i.test(j || '');
}
function isHiddenWealthTwist(t) {
  return /philanthropist|family fortune|built the family|owner of the land|inventor behind|sealed legal document|built the successful|unknown beneficiary|the one who built/i.test(t || '');
}
function isReconciliationEnding(e) {
  return /reconciliation|breaks the cycle and apologizes|gathers again under new rules|apologizes publicly/i.test(e || '');
}

// ---------------- Age & relationship theo theme ----------------
const THEME_REL = {
  A_me_gia: /\b(mother|elderly parent|grandparent|grandmother|stepparent|caregiver|widowed mother)\b/i,
  B_veteran: /\bveteran\b/i,
  C_co_dau: /\b(bride|mother-in-law|new husband)\b/i,
  D_vo_phan_boi: /\b(betrayed wife|widow|widower|late spouse|husband living a double life)\b/i,
  E_ngheo_vs_giau: /\b(poor aunt|poor|wealthy niece|sibling|younger brother|retired employee|entitled|niece|nephew)\b/i,
};
const THEME_AGE_ROLE = {
  A_me_gia: 'elderly_parent', B_veteran: 'veteran', C_co_dau: 'new_bride',
  D_vo_phan_boi: 'betrayed_wife', E_ngheo_vs_giau: 'poor_relative',
};
function relationshipsForTheme(pool, theme) {
  const re = THEME_REL[theme];
  const all = pool.relationship || [];
  if (!re) return all.slice();
  const m = all.filter((r) => re.test(r));
  return m.length ? m : all.slice();
}
function ageForTheme(extra, theme) {
  const role = THEME_AGE_ROLE[theme];
  const rng = (extra.age_range && extra.age_range[role]) || [55, 80];
  const lo = rng[0], hi = rng[1];
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// ---------------- Ten (cooldown + ho chung) ----------------
function fullName(first, surname) { return surname ? `${first} ${surname}` : first; }
function isCloseFamily(relationship) {
  return /mother|father|son|daughter|parent|grandparent|grandchild|grandson|granddaughter|sibling|brother|sister|aunt|uncle|niece|nephew|stepparent|stepchild|stepmother|stepdaughter|widowed mother/i.test(relationship || '');
}

// ---------------- Compatibility rules (R01-R05) ----------------
function compatOk(bp, extra) {
  const rules = extra.compatibility_rules || [];
  for (const r of rules) {
    const when = r.when || {};
    if (when.theme && when.theme !== bp.theme) continue;
    const av = r.avoid || {};
    if (av.icon_keywords && affinityMatch(bp.icon_object, av.icon_keywords)) return { ok: false, reason: `${r.id}: icon "${bp.icon_object}" bị tránh` };
    if (av.twist_keywords && affinityMatch(bp.twist, av.twist_keywords)) return { ok: false, reason: `${r.id}: twist bị tránh` };
    if (av.justice_keywords && affinityMatch(bp.justice_type, av.justice_keywords)) return { ok: false, reason: `${r.id}: justice bị tránh` };
    if (av.relationship_keywords && affinityMatch(bp.relationship, av.relationship_keywords)) return { ok: false, reason: `${r.id}: relationship bị tránh` };
    if (av.hero_age_over && Number(bp.hero_age) > av.hero_age_over) return { ok: false, reason: `${r.id}: hero_age ${bp.hero_age} > ${av.hero_age_over}` };
    if (r.require_one_of && r.require_one_of.evidence_source) {
      if (!affinityMatch(bp.evidence_source || bp.conflict || '', r.require_one_of.evidence_source)) return { ok: false, reason: `${r.id}: thiếu evidence_source` };
    }
  }
  return { ok: true, reason: '' };
}

// ---------------- Chon conflict theo theme (subgroup rotation + cooldown + severity) ----------------
function chooseConflict(country, theme, conf, wr) {
  const catalog = (conf.conflict_catalog || []).filter((x) => x.theme === theme);
  if (!catalog.length) return null;
  const sp = conf.selection_policy || {};
  const cooldown = sp.recent_conflict_cooldown_days || 21;

  // subgroup vua dung nhieu trong 5 bai gan nhat cung theme -> giam
  const recentSameTheme = memory.recentByCountry(country, 5 * 5).filter((e) => e.combo && e.combo.theme === theme).slice(0, 5);
  const subCount = {};
  for (const e of recentSameTheme) { const sg = e.combo.subgroup; if (sg) subCount[sg] = (subCount[sg] || 0) + 1; }

  const sevTarget = sp.severity_distribution || { 2: 0.15, 3: 0.6, 4: 0.25 };
  const weights = catalog.map((item) => {
    const days = memory.daysSinceField(country, 'conflict_id', item.id);
    if (days < cooldown) return 0;                       // conflict_id cooldown (hard)
    let w = 1;
    w *= (sevTarget[String(item.severity)] != null ? (0.2 + sevTarget[String(item.severity)]) : 0.3); // uu tien severity theo phan phoi
    const used = subCount[item.subgroup] || 0;
    if (used >= 2) w *= 0.15;                             // subgroup lap >2/5 -> giam manh
    else if (used === 1) w *= 0.6;
    if (days === Infinity) w *= (wr.underused_item_bonus_multiplier || 1.5);
    return w;
  });
  let pick = weightedRandom(catalog, weights);
  if (!pick) pick = pickOne(catalog);
  return pick;
}

// ---------------- Sinh 1 BLUEPRINT (chay generation_order) ----------------
function buildOnce(country, theme, pool, extra, conf, cfg) {
  const wr = cfg.weighted_random || {};
  const nameRules = cfg.name_rules || {};
  const plot = cfg.plot_rules || {};
  const aff = (extra.theme_affinity && extra.theme_affinity[theme]) || {};
  const dedup = extra.dedup_policy || {};
  const hard = dedup.hard_block_days || {};
  const soft = dedup.soft_penalty_days || {};

  const bp = { theme };

  // 2) conflict theo theme
  const cf = chooseConflict(country, theme, conf, wr);
  if (cf) { bp.conflict_id = cf.id; bp.conflict = cf.conflict; bp.subgroup = cf.subgroup; bp.conflict_tags = cf.tags || []; }
  else { bp.conflict_id = ''; bp.conflict = ''; bp.subgroup = ''; bp.conflict_tags = []; }

  // 3) age + relationship
  bp.relationship = pickOne(relationshipsForTheme(pool, theme)) || '';
  bp.hero_age = ageForTheme(extra, theme);

  // 4) ten (cooldown + ho chung neu gia dinh gan)
  const surnames = extra.surname || [];
  const heroFirst = chooseWeighted(pool.hero_name || [], { country, field: 'hero_first', hardDays: nameRules.hero_name_cooldown_days || 60, wr });
  let villainFirst = chooseWeighted(pool.villain_name || [], { country, field: 'villain_first', hardDays: nameRules.villain_name_cooldown_days || 30, wr });
  if (villainFirst === heroFirst && nameRules.prevent_same_first_name_in_story) {
    villainFirst = pickOne((pool.villain_name || []).filter((n) => n !== heroFirst)) || villainFirst;
  }
  const heroSurname = surnames.length ? pickOne(surnames) : '';
  const villainSurname = (nameRules.same_surname_for_close_family && isCloseFamily(bp.relationship))
    ? heroSurname
    : (surnames.length ? pickOne(surnames) : '');
  bp.hero_first = heroFirst; bp.hero_surname = heroSurname; bp.hero_full_name = fullName(heroFirst, heroSurname);
  bp.villain_first = villainFirst; bp.villain_surname = villainSurname; bp.villain_full_name = fullName(villainFirst, villainSurname);

  // 5) location + town_setting + season + weather
  bp.location = chooseWeighted(pool.location || [], { country, field: 'location', softDays: soft.location, wr }) || '';
  bp.town_setting = pickOne(extra.town_setting || ['']) || '';
  bp.season_event = pickOne((aff.preferred_events && aff.preferred_events.length) ? aff.preferred_events : (extra.season_event || [''])) || '';
  bp.weather_mood = pickOne(extra.weather_mood || ['']) || '';

  // 6) occupation (affinity)
  bp.occupation = chooseWeighted(pool.occupation || [], { country, field: 'occupation', affinityKeywords: aff.preferred_occupations, affinityHard: true, softDays: soft.occupation, wr }) || '';

  // 7) icon_object (affinity, hard cooldown)
  bp.icon_object = chooseWeighted(pool.icon_object || [], { country, field: 'icon_object', affinityKeywords: aff.preferred_objects, affinityHard: true, hardDays: hard.icon_object, wr }) || '';

  // 8) opening_scene
  bp.opening_scene = chooseWeighted(pool.opening_scene || [], { country, field: 'opening_scene', softDays: soft.opening_scene, wr }) || '';

  // 9) humiliation_type
  bp.humiliation_type = pickOne(pool.humiliation_type || ['']) || '';

  // 10) twist (reveal) — plot: gioi han hidden-wealth reveal
  const hwRate = memory.rateRecent(country, 20, (c) => isHiddenWealthTwist(c.twist)).rate;
  const excludeTwist = new Set();
  if (hwRate >= (plot.max_hidden_wealth_reveal_rate != null ? plot.max_hidden_wealth_reveal_rate : 0.2)) {
    for (const t of (pool.twist || [])) if (isHiddenWealthTwist(t)) excludeTwist.add(t);
  }
  bp.twist = chooseWeighted(pool.twist || [], { country, field: 'twist', wr, exclude: excludeTwist }) || '';
  bp.reveal_type = bp.twist;

  // 11) justice_type — plot: gioi han authority-rescue
  const arRate = memory.rateRecent(country, 20, (c) => isAuthorityRescueJustice(c.justice_type)).rate;
  const excludeJust = new Set();
  if (arRate >= (plot.max_powerful_authority_rescue_rate != null ? plot.max_powerful_authority_rescue_rate : 0.25)) {
    for (const j of (pool.justice_type || [])) if (isAuthorityRescueJustice(j)) excludeJust.add(j);
  }
  bp.justice_type = chooseWeighted(pool.justice_type || [], { country, field: 'justice_type', softDays: soft.justice_type, wr, exclude: excludeJust }) || '';

  // 12) ending — plot: tranh total reconciliation (avoid_total_reconciliation_rate)
  const recRate = memory.rateRecent(country, 20, (c) => isReconciliationEnding(c.ending)).rate;
  const excludeEnd = new Set();
  const maxRecon = 1 - (plot.avoid_total_reconciliation_rate != null ? plot.avoid_total_reconciliation_rate : 0.7);
  if (recRate >= maxRecon) {
    for (const e of (pool.ending || [])) if (isReconciliationEnding(e)) excludeEnd.add(e);
  }
  bp.ending = chooseWeighted(pool.ending || [], { country, field: 'ending', softDays: soft.ending, wr, exclude: excludeEnd }) || '';

  // 13) emotion (affinity)
  bp.dominant_emotion = chooseWeighted(pool.dominant_emotion || [], { country, field: 'dominant_emotion', affinityKeywords: aff.preferred_emotions, affinityHard: true, wr }) || '';

  // evidence_source (theme D can bang chung cu the)
  const EVID = ['camera', 'GPS', 'messages', 'bank records', 'DNA', 'cloud photos', 'call log'];
  const foundEv = EVID.find((k) => lc(bp.conflict).includes(lc(k)));
  bp.evidence_source = foundEv || (theme === 'D_vo_phan_boi' ? pickOne(EVID) : '');

  // yeu cau agency (plot): ep AI cho nhan vat tu quyet o hoi cuoi + object xuat hien 3 phan
  bp.require_hero_choice = !!plot.require_hero_choice_in_final_act;
  bp.require_cost = !!plot.require_cost_or_consequence;
  bp.object_in_parts = plot.object_must_appear_in_parts || ['P1', 'P2', 'P3'];

  // truong tuong thich cu (cho story-writer log)
  bp.hero_name = bp.hero_full_name;
  bp.villain_name = bp.villain_full_name;
  bp.villain_type = bp.relationship;

  return bp;
}

// story_signature = hash cac signature_fields
function buildSignature(bp, extra) {
  const fields = (extra.dedup_policy && extra.dedup_policy.signature_fields) || ['theme', 'conflict_id', 'hero_full_name', 'villain_full_name', 'icon_object', 'twist', 'justice_type', 'ending'];
  const parts = fields.map((f) => lc(bp[f]));
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Chon 1 blueprint HOP LE + KHONG TRUNG cho (country, niche).
 * @returns {combo, country, theme, tries, regen, fellBack, poolEmpty, valid, conflictBranch, hasConflict, signature}
 */
function pickCombo(country, niche, nicheCode, { maxTries = 60 } = {}) {
  const c = String(country || DEFAULT_COUNTRY).toUpperCase();
  const pool = poolAxes(c);
  const extra = poolExtra(c);
  const conf = conflictData(c);
  const cfg = engineConfig(c);
  const theme = themeCodeOf(nicheCode, niche);

  if (!poolHasContent(pool)) {
    return { combo: {}, country: c, theme, tries: 0, regen: 0, fellBack: false, poolEmpty: true, valid: false, conflictBranch: '', hasConflict: false, signature: '' };
  }

  const sigHard = (extra.dedup_policy && extra.dedup_policy.hard_block_days && extra.dedup_policy.hard_block_days.story_signature) || 365;
  let tries = 0, regen = 0, lastReason = '';
  let bp = null, sig = '';
  while (tries < maxTries) {
    tries++;
    bp = buildOnce(c, theme, pool, extra, conf, cfg);
    // validate compatibility
    const comp = compatOk(bp, extra);
    if (!comp.ok) { regen++; lastReason = comp.reason; continue; }
    // story_signature dedup theo ngay
    sig = buildSignature(bp, extra);
    bp.story_signature = sig;
    const sigDays = memory.daysSinceSignature(c, sig);
    if (sigDays < sigHard) { regen++; lastReason = `story_signature trùng (${Math.round(sigDays)} ngày < ${sigHard})`; continue; }
    // OK
    return { combo: bp, country: c, theme, tries, regen, fellBack: false, poolEmpty: false, valid: true, conflictBranch: bp.subgroup || '', hasConflict: !!bp.conflict, signature: sig, lastReason: '' };
  }
  // het luot -> chot cai cuoi
  if (bp && !bp.story_signature) bp.story_signature = buildSignature(bp, extra);
  return { combo: bp || {}, country: c, theme, tries, regen, fellBack: true, poolEmpty: false, valid: false, conflictBranch: (bp && bp.subgroup) || '', hasConflict: !!(bp && bp.conflict), signature: (bp && bp.story_signature) || '', lastReason };
}

// ---------------- Khoi DNA nhet vao DAU prompt (ep AI ke theo) ----------------
function buildDnaBlock(bp, country) {
  const g = (k) => (bp && bp[k] ? bp[k] : '(bất kỳ)');
  const lines = [
    `[STORY DNA — ${String(country || DEFAULT_COUNTRY).toUpperCase()} | theme=${g('theme')}]`,
    'BẮT BUỘC dùng ĐÚNG các yếu tố sau, KHÔNG đổi tên/vật/nút lật:',
    `- hero_full_name = ${g('hero_full_name')} (tuổi ${g('hero_age')})`,
    `- villain_full_name = ${g('villain_full_name')}`,
    `- relationship = ${g('relationship')}`,
    `- occupation = ${g('occupation')}`,
    `- location = ${g('location')} | town = ${g('town_setting')} | dịp = ${g('season_event')} | không khí = ${g('weather_mood')}`,
    `- icon_object = ${g('icon_object')}`,
    `- opening_scene = ${g('opening_scene')}`,
    `- humiliation = ${g('humiliation_type')}`,
  ];
  if (bp && bp.conflict) lines.push(`- conflict = ${bp.conflict}`);
  lines.push(`- reveal (twist) = ${g('twist')}`);
  lines.push(`- justice = ${g('justice_type')}`);
  lines.push(`- ending = ${g('ending')}`);
  lines.push(`- emotion = ${g('dominant_emotion')}`);
  if (bp && bp.evidence_source) lines.push(`- evidence_source = ${bp.evidence_source} (bằng chứng phải cụ thể, xuất hiện trước khi đối chất)`);
  // ép plot_rules (agency / cost / object)
  const parts = (bp && bp.object_in_parts) ? bp.object_in_parts.join(', ') : 'P1, P2, P3';
  lines.push(`- BẮT BUỘC: icon_object phải xuất hiện ở CẢ 3 phần (${parts}).`);
  if (!bp || bp.require_hero_choice) lines.push('- BẮT BUỘC: ở HỒI CUỐI, chính nhân vật tự đưa ra lựa chọn/quyết định (KHÔNG để người quyền lực ra tay cứu hộ thay).');
  if (!bp || bp.require_cost) lines.push('- BẮT BUỘC: chiến thắng phải có cái giá/hệ quả, không "thắng dễ".');
  lines.push('- CHỈ 1 major reveal duy nhất; KHÔNG hoà giải trọn vẹn nếu không hợp lý.');
  lines.push('Skill kể câu chuyện xoay quanh ĐÚNG blueprint này. Giữ nguyên toàn bộ khuôn xuất ===...=== bên dưới.');
  lines.push('');
  return lines.join('\n');
}

// ---------------- Ghi so ----------------
function remember({ storyId, country, niche, combo }) {
  const bp = combo || {};
  memory.add({ storyId, country, niche, combo: bp });
}

// JSON cho cot story_dna (blueprint day du)
function comboToSheetJson(bp, country, theme) {
  const c = bp || {};
  return JSON.stringify({
    country: String(country || DEFAULT_COUNTRY).toUpperCase(),
    theme: c.theme || theme || '',
    conflict_id: c.conflict_id || '',
    hero_full_name: c.hero_full_name || '',
    hero_age: c.hero_age || '',
    villain_full_name: c.villain_full_name || '',
    relationship: c.relationship || '',
    occupation: c.occupation || '',
    location: c.location || '',
    town_setting: c.town_setting || '',
    season_event: c.season_event || '',
    weather_mood: c.weather_mood || '',
    icon_object: c.icon_object || '',
    opening_scene: c.opening_scene || '',
    humiliation_type: c.humiliation_type || '',
    twist: c.twist || '',
    justice_type: c.justice_type || '',
    ending: c.ending || '',
    dominant_emotion: c.dominant_emotion || '',
    evidence_source: c.evidence_source || '',
    story_signature: c.story_signature || '',
  });
}

module.exports = {
  AXES, AXIS_KEYS, DEFAULT_COUNTRY,
  listCountries, getPool, savePool,
  pickCombo, buildDnaBlock, remember, comboToSheetJson, buildSignature, themeCodeOf,
  // phan loai (cho test)
  isAuthorityRescueJustice, isHiddenWealthTwist, isReconciliationEnding,
};
