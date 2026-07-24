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
const nameGender = require('./name-gender');

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
  const { familyOf, softFamilies, hardFamilies, bonusFamilies } = arguments[1] || {};
  const weights = list.map((item) => {
    const days = memory.daysSinceField(country, field, item);
    if (hardDays != null && days < hardDays) return 0;               // hard block theo ngay
    const fam = familyOf ? familyOf(item) : null;
    if (fam && hardFamilies && hardFamilies.has(fam)) return 0;      // hard block theo family
    let w = 1;
    if (affinityMatch(item, affinityKeywords)) w *= (wr.affinity_match_multiplier || 2.5);
    if (softDays != null && days < softDays) w *= (wr.recent_soft_penalty_multiplier != null ? wr.recent_soft_penalty_multiplier : 0.25);
    if (fam && softFamilies && softFamilies.has(fam)) w *= 0.25;     // soft penalty family (lap gan)
    // BONUS affinity cua subcategory (chi la GOI Y): ap SAU hard-block nen 0 van la 0
    // -> cooldown/cap v1.8.1 LUON THANG affinity.
    if (fam && bonusFamilies && bonusFamilies.has(fam)) w *= (wr.affinity_match_multiplier || 2.5);
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

// ==================== LOP 1: GEOGRAPHY v2 (data-driven) ====================
// Nguon: story-geography-US.json (51 bang + 38 town_setting + no_snow + season/weather).
// NGUYEN TAC: bang nay chi CAM to hop vo ly. Thieu du lieu KHONG phai la "cho qua":
//   - town_setting khong co trong bang -> coi la ['generic'] va VAN validate
//     (chi hop voi bang co 'generic' trong state_geo)
//   - season la khong biet -> 'any' (khong rang buoc weather); weather khong biet -> 'any'
//   - khong tim duoc to hop hop le -> weather_mood = '' (tha bo trong con hon mau thuan)
const GEO = bundled('story-geography-US.json') || {};
const GEO_TOWN = GEO.town_setting_groups || {};
const GEO_STATE = GEO.state_geo || {};
const GEO_SEASON_MONTH = GEO.season_month || {};
const GEO_WEATHER_SEASON = GEO.weather_season || {};
const GEO_NO_SNOW = GEO.no_snow_geo || [];
const GEO_SNOW_WEATHER = GEO.snow_weather || [];

function geoKey(s) { return String(s || '').trim().toLowerCase(); }
function geoLookup(table, key) {
  const k = geoKey(key);
  if (!k) return null;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  for (const kk of Object.keys(table)) if (geoKey(kk) === k) return table[kk];
  return null;
}
// Bang khong co trong bang -> 'generic' (khong biet gi ve no thi chi cho di voi town generic)
function geoOfState(loc) { return geoLookup(GEO_STATE, loc) || ['generic']; }
// Tu DIA LY (nang 3 diem) vs tu chung chung (1 diem). Dung de khop town viet khac chu
// nhung cung mot vung — vd pool ghi "a Gulf Coast retirement community" con bang ghi
// "a Gulf Coast shrimping town". KHONG khop duoc moi coi la 'generic'.
const GEO_WORDS = new Set([
  'coastal', 'coast', 'gulf', 'beach', 'harbor', 'island', 'ferry', 'shrimping', 'fishing',
  'lakeside', 'lake', 'lakes', 'north-woods', 'appalachian', 'mountain', 'rockies', 'desert',
  'high-desert', 'sun-baked', 'prairie', 'plains', 'farming', 'farm', 'farmland', 'dairy',
  'ranching', 'delta', 'southern', 'england', 'rust', 'belt', 'steel', 'factory', 'mill',
  'mining', 'midwestern', 'florida', 'subtropical', 'tropical', 'railroad', 'suburban',
  'suburb', 'college', 'highway', 'truck', 'courthouse', 'border',
]);
const GEO_STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'by', 'to', 'from', 'that', 'with', 'and', 'its', 'one', 'only', 'after', 'over', 'outside', 'near', 'already', 'where', 'built', 'around']);
function geoWords(s) {
  return String(s || '').toLowerCase().split(/[^a-z-]+/).filter((w) => w && !GEO_STOP.has(w));
}
const GEO_TOWN_KEYS = Object.keys(GEO_TOWN).map((k) => ({ key: k, words: new Set(geoWords(k)) }));
function resolveTownKey(town) {
  const ws = geoWords(town);
  if (!ws.length) return null;
  let best = null, bestScore = 0;
  for (const cand of GEO_TOWN_KEYS) {
    let score = 0;
    for (const w of ws) if (cand.words.has(w)) score += GEO_WORDS.has(w) ? 3 : 1;
    if (score > bestScore) { bestScore = score; best = cand.key; }
  }
  // Phai co it nhat 1 tu DIA LY trung (>=3 diem) moi tin; khong thi tra null -> 'generic'
  return bestScore >= 3 ? best : null;
}
// town khong co trong bang -> thu khop tu khoa -> cuoi cung moi la 'generic'.
// 'generic' VAN duoc validate (chi hop voi bang co 'generic'), KHONG phai la "cho qua".
function geoOfTown(town) {
  const direct = geoLookup(GEO_TOWN, town);
  if (direct) return direct;
  const k = resolveTownKey(town);
  if (k) return GEO_TOWN[k];
  return ['generic'];
}
function townCompatLocation(town, loc) {
  const tg = geoOfTown(town);
  const lg = geoOfState(loc);
  return tg.some((g) => lg.includes(g));
}
function seasonOf(season) { return geoLookup(GEO_SEASON_MONTH, season) || 'any'; }
function weatherSeasonsOf(weather) { return geoLookup(GEO_WEATHER_SEASON, weather) || ['any']; }
// Co tra duoc trong BANG LUAT khong? (dung cho GUARD — phan biet "tra duoc" vs "roi fallback any")
function weatherInTable(w) { return geoLookup(GEO_WEATHER_SEASON, w) !== null; }
function seasonInTable(s) { return geoLookup(GEO_SEASON_MONTH, s) !== null; }
function townInTable(t) { return geoLookup(GEO_TOWN, t) !== null || resolveTownKey(t) !== null; }

// ==================== GUARD: khong tra duoc bang luat -> DUNG + BAO LOI TO ====================
// Truoc day cac gia tri nay am tham roi fallback ('any' / thung mac dinh) lam thong ke sai
// hang thang ma khong ai biet. Nay bat loi ngay tai cho.
function assertMapped(field, value, mapped, hint) {
  if (!value) return;                       // rong la hop le (vd weather_mood co the de trong)
  if (mapped) return;
  const e = new Error(
    `[DNA GUARD] Trường "${field}" có giá trị "${value}" KHÔNG tra được trong bảng luật — `
    + `dừng bài để tránh thống kê sai. ${hint}`
  );
  e.dnaGuard = true;
  throw e;
}
function seasonWeatherOk(season, weather) {
  const s = seasonOf(season);
  const ws = weatherSeasonsOf(weather);
  if (s === 'any' || ws.includes('any')) return true;
  return ws.includes(s);
}
function isSnowWeather(w) {
  const k = geoKey(w);
  return GEO_SNOW_WEATHER.some((x) => geoKey(x) === k);
}
function locationWeatherOk(loc, weather) {
  const g = geoOfState(loc);
  if (g.some((x) => GEO_NO_SNOW.includes(x)) && isSnowWeather(weather)) return false;
  return true;
}
function geoComboOk(loc, town, season, weather) {
  if (!townCompatLocation(town, loc)) return false;
  if (weather && !seasonWeatherOk(season, weather)) return false;
  if (weather && !locationWeatherOk(loc, weather)) return false;
  return true;
}

// ==================== LOP 2: FAMILY (ngu nghia, khong theo text) ====================
// ==================== PHAN LOAI FAMILY ====================
// B (CHINH): pool khai thang nhan cho tung gia tri -> engine CHI DOC.
// A (DU PHONG): chi chay khi pool CHUA khai. Khong co "thung mac dinh": khong khop
//               -> tra '' -> guard o buildOnce BAO LOI TO va dung bai.
// Bang khai trong pool (tuy chon): pool.family_map = { twist:{...}, justice_type:{...}, relationship:{...} }
function poolFamilyOf(field, value) {
  try {
    const pools = readUserPools();
    const country = DEFAULT_COUNTRY;
    const p = (pools[country] || POOL_BUNDLED[country] || {});
    const fm = p.family_map || {};
    const tbl = fm[field] || {};
    const key = String(value || '').trim();
    if (Object.prototype.hasOwnProperty.call(tbl, key)) return tbl[key];
    const lk = lc(key);
    for (const k of Object.keys(tbl)) if (lc(k) === lk) return tbl[k];
  } catch (_) { /* pool hong -> de A lo */ }
  return '';
}

// --- A: reveal_family. Thu tu quan trong (cu the -> chung chung). ---
function classifyReveal(twist) {
  const t = lc(twist);
  if (!t) return 'no_major_reveal';
  if (/^(no|nothing)\b/.test(t)) return 'no_major_reveal';
  // nan nhan TU noi ra (narrator la chu the)
  if (/\bthe narrator (has|made|left|set|kept|gave|stopped|did|once told)\b|\bwhat the narrator\b|\bwhy the narrator\b|\bthe real reason the narrator\b|\ban apology the narrator\b|\bthe condition the narrator\b|\bsaid out loud\b|\bsaid plainly\b|\bfinally (explained|delivers)\b/.test(t)) return 'self_disclosure';
  // hau qua TU DEN, khong ai tiet lo (ke sai tu lam lo)
  if (/\bwrongdoer\b|\bcomes due\b|\bunravels\b|\bfailing without\b|\bdoes not add up\b|\bcannot explain away\b|\bcannot keep\b/.test(t)) return 'natural_consequence';
  // bang chung VAT / giay to
  if (/\b(ledger|receipt|bank record|records?|insurance form|signed form|form|checks?|deed|patent|voicemail|diary|letter|sealed legal document|beneficiary|will|photograph|phone|hospital bill|bill|lease|scrapbook|pawn ticket|postcards?|work log|log)\b/.test(t)) return 'document_evidence';
  // NGUOI THUONG chung kien / tung giup (ben thu ba, khong chuc danh lon)
  if (/\b(teacher|coworker|neighbour|neighbor|waitress|mechanic|hairdresser|clerk|bus driver|volunteer|foster parent|witness)\b|\bthe person who paid\b|\bperson whose recipe\b|\bused to deliver\b|\bnight-shift nurse\b|\bthe child the narrator\b/.test(t)) return 'ordinary_witness';
  // NGUOI CO VI THE CONG (chuc danh, thanh tich)
  if (/\b(veteran|surgeon|judge|officer|firefighter|philanthropist|donor|detective|medic|athlete|inventor|public defender|business owner|nurse|commander|champion)\b|\bowner of the land\b|\bbuilt the family\b|\bfortune\b/.test(t)) return 'external_public_validator';
  return '';                                  // KHONG khop -> guard bao loi
}
function revealFamily(twist) {
  return poolFamilyOf('twist', twist) || classifyReveal(twist);
}
// --- A: justice_family. Khong con thung mac dinh private_resolution. ---
function classifyJustice(j) {
  const s = lc(j);
  if (!s) return '';
  if (/quietly walks away|refusing to beg|declines money|calmly ends the arrangement|walks away with|and leaves\b/.test(s)) return 'walk_away_dignity';
  if (/only one who can save|competence saves|saves the very person|goes to charity/.test(s)) return 'hero_choice';
  if (/official records|audit|legal review|records prove|careful records|controls the only key document|patent|property right|formally apologi|recorded|read back|letter or document reveals/.test(s)) return 'procedural';
  if (/publicly|community rallies|honors|standing ovation|plaque|award|recognizes them|authority figure|someone the villain respects|takes the narrator's side|shocked room|comes out|stands up and tells|repeats the villain|chooses the narrator|identifies the narrator/.test(s)) return 'public_recognition';
  // cong ly RIENG TU: noi that giua hai nguoi, khong khan gia, khong thu tuc
  if (/private conversation|finally said between|quietly accepts|comes back and admits/.test(s)) return 'private_resolution';
  return '';                                  // KHONG khop -> guard bao loi
}
function justiceFamily(j) {
  return poolFamilyOf('justice_type', j) || classifyJustice(j);
}

// --- A: relationship_family. Khong con thung mac dinh parent_vs_adult_child. ---
function classifyRelationship(rel) {
  const r = lc(rel);
  if (!r) return '';
  if (/grandparent|grandchild|grandson|granddaughter|grandmother|grandfather/.test(r)) return 'grandparent_vs_grandchild';
  if (/\bbride\b|mother-in-law|father-in-law|new husband/.test(r)) return 'bride_vs_inlaws';
  if (/betrayed wife|widow|widower|late spouse|double life/.test(r)) return 'spouse_betrayal';
  if (/\bveteran\b/.test(r)) return 'veteran_vs_civilian';
  if (/sibling|brother|sister/.test(r)) return 'sibling_rivalry';
  if (/employee|boss|founder/.test(r)) return 'work_hierarchy';
  // ho hang / nguoi cham soc vs nha nguoi ta. Dat TRUOC parent vi "stepchildren" se bi
  // parent nuot mat (vo/chong DA MAT thi khong con phan boi hon nhan — la xung dot ho hang).
  if (/aunt|uncle|niece|nephew|caregiver and relatives|live-in caregiver|caregiver and the family|late-life spouse|stepchildren from the first marriage|late spouse's/.test(r)) return 'extended_family';
  if (/mother|father|parent|son|daughter|stepchild|stepdaughter/.test(r)) return 'parent_vs_adult_child';
  return '';                                  // KHONG khop -> guard bao loi
}
function relationshipFamily(rel) {
  return poolFamilyOf('relationship', rel) || classifyRelationship(rel);
}
// ==================== LOP 3: GIOI TINH VAI (hero/villain phai khop conflict) ====================
// Doc giao tu TEXT cua conflict + relationship. Chi ket luan khi co dau hieu RO RANG;
// khong ro -> null -> tu do chon ten.
const HERO_F = [
  /\bthe mother\b/, /\bmother and\b/, /\band (?:her|his) mother\b/, /\bthe grandmother\b/,
  /\bthe bride\b/, /\bthe widow\b/, /\bthe wife\b/, /\bbetrayed wife\b/, /\bthe daughter-in-law\b/,
  /\bthe mother-in-law\b/, /\bthe aunt\b/, /\bpoor aunt\b/, /\bthe sister\b/, /\bthe grandma\b/,
  /\bwidowed mother\b/, /\bher (?:son|daughter|husband|children)\b/,
];
const HERO_M = [
  /\bthe father\b/, /\bfather and\b/, /\band (?:her|his) father\b/, /\bthe grandfather\b/,
  /\bthe veteran\b/, /\bthe widower\b/, /\bthe husband\b/, /\bthe uncle\b/, /\bthe brother\b/,
  /\bthe grandpa\b/, /\bhis (?:son|daughter|wife|children|service)\b/, /\bnew husband\b/,
];
const VILL_F = [/\bthe daughter\b/, /\bdaughter-in-law\b/, /\bthe niece\b/, /\bwealthy niece\b/, /\bthe stepdaughter\b/, /\bthe sister-in-law\b/];
const VILL_M = [/\bthe son\b/, /\bson-in-law\b/, /\bthe nephew\b/, /\bthe stepson\b/, /\bthe brother-in-law\b/, /\byounger brother\b/];
function matchAny(res, text) { return res.some((re) => re.test(text)); }
/**
 * Suy gioi tinh BAT BUOC cho hero/villain tu conflict + relationship.
 * @returns {{hero: 'F'|'M'|null, villain: 'F'|'M'|null}}
 */
function requiredGenders(conflictText, relationshipText) {
  const t = lc(String(conflictText || '') + ' || ' + String(relationshipText || ''));
  let hero = null, villain = null;
  const hf = matchAny(HERO_F, t), hm = matchAny(HERO_M, t);
  if (hf && !hm) hero = 'F'; else if (hm && !hf) hero = 'M';   // ca hai cung dung -> khong ket luan
  const vf = matchAny(VILL_F, t), vm = matchAny(VILL_M, t);
  if (vf && !vm) villain = 'F'; else if (vm && !vf) villain = 'M';
  return { hero, villain };
}

// ==================== LOP 4: RELATIONSHIP phai khop SUBCATEGORY ====================
// Data khong co truong relationship_affinity -> suy tu chinh TEN + PREMISE cua subcategory
// (va ten category) bang chinh bo phan loai relationshipFamily. Khong co dau hieu -> null (tu do).
const REL_FAM_HINTS = [
  [/grandchild|grandparent|grandson|granddaughter|grandmother|grandfather/, 'grandparent_vs_grandchild'],
  [/veteran|service member|military service|stolen valor/, 'veteran_vs_civilian'],
  [/bride|in-law|wedding party|mother-in-law/, 'bride_vs_inlaws'],
  [/widow|widower|spouse|marriage|husband|wife|affair/, 'spouse_betrayal'],
  [/sibling|brother|sister/, 'sibling_rivalry'],
  [/workplace|employer|employee|coworker|boss|career|retirement benefit|fired|laid off/, 'work_hierarchy'],
  [/aunt|uncle|niece|nephew|cousin/, 'extended_family'],
];
function requiredRelFamily(input) {
  if (!input) return null;
  // status_dynamic la tin hieu MANH nhat: "caregiver_vs_inheritors" = nguoi cham soc vs ho hang
  // -> extended_family. Truoc day C03S08 tra null nen engine boc nham bride_vs_inlaws (loi ST31).
  if (input.status_dynamic === 'caregiver_vs_inheritors') return 'extended_family';
  const t = lc([input.subcategory_name, input.conflict_premise, input.category_name].filter(Boolean).join(' | '));
  if (!t) return null;
  // dau hieu nguoi cham soc / nguoi thua ke khong cung huyet thong
  if (/chosen heir|blood relative|caregiver or neighbor|live-in caregiver/.test(t)) return 'extended_family';
  for (const [re, fam] of REL_FAM_HINTS) if (re.test(t)) return fam;
  return null;                                              // khong co dau hieu -> khong rang buoc
}

// Family reveal it dung (uu tien khi phai doi loai)
const UNDERUSED_REVEAL = new Set(['document_evidence', 'self_disclosure', 'ordinary_witness', 'natural_consequence']);
const UNDERUSED_JUSTICE = new Set(['procedural', 'hero_choice', 'walk_away_dignity', 'private_resolution']);

// ---------------- Age & relationship theo theme ----------------
const THEME_REL = {
  A_me_gia: /\b(mother|elderly parent|grandparent|grandmother|stepparent|caregiver|widowed mother)\b/i,
  B_veteran: /\bveteran\b/i,
  C_co_dau: /\b(bride|mother-in-law|new husband)\b/i,
  D_vo_phan_boi: /\b(betrayed wife|widow|widower|late spouse|husband living a double life)\b/i,
  E_ngheo_vs_giau: /\b(poor aunt|poor|wealthy niece|sibling|younger brother|retired employee|entitled|niece|nephew)\b/i,
  F_anh_chi_em: /\b(sibling|brother|sister)\b/i,                       // anh chi em
  G_cong_dong: /\b(neighbor|community|congregation|church|volunteer|town|friend)\b/i, // cong dong
};
const THEME_AGE_ROLE = {
  A_me_gia: 'elderly_parent', B_veteran: 'veteran', C_co_dau: 'new_bride',
  D_vo_phan_boi: 'betrayed_wife', E_ngheo_vs_giau: 'poor_relative',
  F_anh_chi_em: 'elderly_parent', G_cong_dong: 'elderly_parent',      // vai chinh vẫn nguoi cao tuoi
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
    // R06: cam CHI TIET QUA LON (Medal of Honor, 4-sao, Olympic, Nobel, ty phu...) o BAT KY truc nao.
    // Doc gia 55+ nhan ra ngay chi tiet hiem gap -> mat tin ca bai. Dung phien ban DOI THUONG.
    if (av.oversized_credential_keywords) {
      const hay = [bp.twist, bp.occupation, bp.conflict, bp.icon_object, bp.humiliation_type,
        bp.opening_scene, bp.dominant_emotion, bp.villain_type, bp.relationship, bp.ending, bp.justice_type]
        .filter(Boolean).join(' | ');
      const hit = av.oversized_credential_keywords.find((k) => affinityMatch(hay, [k]));
      if (hit) return { ok: false, reason: `${r.id}: chi tiết quá lớn "${hit}" — dùng phiên bản đời thường` };
    }
  }

  // R-GEO: location x town x season x weather (LOP 1 v2, town la khong biet VAN validate)
  if (bp.location && bp.town_setting && !townCompatLocation(bp.town_setting, bp.location)) {
    return { ok: false, reason: `R-GEO: "${bp.town_setting}" không hợp địa lý của ${bp.location}` };
  }
  if (bp.weather_mood && !seasonWeatherOk(bp.season_event, bp.weather_mood)) {
    return { ok: false, reason: `R-GEO: "${bp.weather_mood}" không hợp mùa của "${bp.season_event}"` };
  }
  if (bp.weather_mood && !locationWeatherOk(bp.location, bp.weather_mood)) {
    return { ok: false, reason: `R-GEO: ${bp.location} không thể có "${bp.weather_mood}"` };
  }

  // R-GENDER: ten phai khop gioi tinh ma conflict/relationship da chi ro (LOP 3)
  const ng = requiredGenders(bp.conflict, bp.relationship);
  if (ng.hero && bp.hero_first && nameGender.gender(bp.hero_first) !== ng.hero) {
    return { ok: false, reason: `R-GENDER: hero "${bp.hero_first}" không khớp giới tính ${ng.hero} mà conflict yêu cầu` };
  }
  if (ng.villain && bp.villain_first && nameGender.gender(bp.villain_first) !== ng.villain) {
    return { ok: false, reason: `R-GENDER: villain "${bp.villain_first}" không khớp giới tính ${ng.villain} mà conflict yêu cầu` };
  }

  // R-REL: relationship_family phai khop subcategory (LOP 4)
  if (bp.required_rel_family && bp.relationship
      && relationshipFamily(bp.relationship) !== bp.required_rel_family) {
    return { ok: false, reason: `R-REL: relationship "${bp.relationship}" không thuộc nhóm ${bp.required_rel_family} của subcategory` };
  }

  return { ok: true, reason: '' };
}

// ---------------- Chon conflict theo theme (subgroup rotation + cooldown + severity) ----------------
/**
 * @param allowIds (tuy chon) tap id conflict tu LOP DAU VAO (category/subcategory).
 *   Conflict fidelity xep DUOI hard-compat + cooldown: neu loc theo allowIds ma het ung vien
 *   (moi cai deu bi cooldown) thi TU DONG bo rang buoc nay -> khong bao gio null/crash.
 */
function chooseConflict(country, theme, conf, wr, allowIds) {
  const all = conf.conflict_catalog || [];
  let catalog = null;
  // (b) UU TIEN conflict_ids cua SUBCATEGORY truoc — subcategory moi la thu quyet dinh noi dung.
  //     legacy_theme chi la thuoc tinh PHU: chi dung de loc THEM trong tap do, va chi khi
  //     loc xong VAN CON DU ung vien (>=3). Neu loc theo theme lam can kiet -> bo qua theme.
  if (allowIds && allowIds.length) {
    const allow = new Set(allowIds);
    catalog = all.filter((x) => allow.has(x.id));
    // theme RONG (subcategory khong khai legacy_theme) -> KHONG loc theme, thuan conflict_ids
    if (catalog.length && theme) {
      const byTheme = catalog.filter((x) => x.theme === theme);
      if (byTheme.length >= 3) catalog = byTheme;
    }
  }
  // Khong co conflict_ids (hoac rong) -> quay ve loc theo theme nhu cu.
  // Theme cung rong -> khong con rang buoc nao: lay toan catalog (khong bao gio tra ve null).
  if (!catalog || !catalog.length) catalog = theme ? all.filter((x) => x.theme === theme) : all.slice();
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
  // Neu tap da thu hep (conflict fidelity) ma MOI cai deu bi cooldown chan -> cooldown THANG
  // affinity/fidelity: mo lai toan bo catalog cua theme roi chon lai.
  if (!pick && allowIds && allowIds.length) {
    const full = theme ? all.filter((x) => x.theme === theme) : all;
    if (full.length > catalog.length) return chooseConflict(country, theme, conf, wr, null);
  }
  if (!pick) pick = pickOne(catalog);
  return pick;
}

// ---------------- Sinh 1 BLUEPRINT (chay generation_order) ----------------
function buildOnce(country, theme, pool, extra, conf, cfg, input) {
  const wr = cfg.weighted_random || {};
  const nameRules = cfg.name_rules || {};
  const plot = cfg.plot_rules || {};
  const dedup = extra.dedup_policy || {};
  const hard = dedup.hard_block_days || {};
  const soft = dedup.soft_penalty_days || {};

  const bp = {};

  // 2) conflict theo theme
  // LOP DAU VAO: neu co category/subcategory -> loc conflict theo tap cua subcategory
  const cf = chooseConflict(country, theme, conf, wr, input ? input.conflict_ids : null);
  if (cf) { bp.conflict_id = cf.id; bp.conflict = cf.conflict; bp.subgroup = cf.subgroup; bp.conflict_tags = cf.tags || []; }
  else { bp.conflict_id = ''; bp.conflict = ''; bp.subgroup = ''; bp.conflict_tags = []; }

  // Theme HIEU LUC cho cac buoc sau (age/relationship/affinity/compat-rules):
  // subcategory khong khai legacy_theme -> lay theme cua CONFLICT vua chon (dong bo voi noi dung
  // that su duoc chon), KHONG suy nguoc tu bang legacy_theme_to_categories.
  const effTheme = theme || (cf && cf.theme) || '';
  bp.theme = effTheme;
  const aff = (extra.theme_affinity && extra.theme_affinity[effTheme]) || {};

  // LOP DAU VAO: gan category/subcategory/page + legacy_theme + status_dynamic vao blueprint
  if (input) {
    bp.page_profile_id = input.page_profile_id || '';
    bp.category_id = input.category_id || '';
    bp.category_name = input.category_name || '';
    bp.subcategory_id = input.subcategory_id || '';
    bp.subcategory_name = input.subcategory_name || '';
    bp.conflict_premise = input.conflict_premise || '';
    // legacy_theme cua data la su that: rong thi de rong, khong bia
    bp.legacy_theme = input.legacy_theme || '';
    // Conflict lay tu fallback CAP CATEGORY (khong thuoc tap rieng cua subcategory)?
    // Khi do premise cua subcategory moi la chuan; conflict chi la tinh huong tham khao.
    const own = input.conflict_ids_own || input.conflict_ids || [];
    bp.conflict_scope = (bp.conflict_id && own.indexOf(bp.conflict_id) >= 0) ? 'subcategory' : 'category';
    bp.status_dynamic = input.status_dynamic || '';
  }

  // 3) age + relationship
  // LOP 4: relationship phai khop SUBCATEGORY (vd sub ve grandchild thi khong duoc ra
  // "mother and adult daughter"). Loc truoc khi random; het ung vien thi moi tha.
  const relCands = relationshipsForTheme(pool, effTheme);
  const needRelFam = requiredRelFamily(input);
  // Subcategory THANG legacy_theme: tim trong TOAN BO pool, khong chi tap da loc theo theme
  // (vd sub "Sibling..." trong theme A_me_gia — theme loc het quan he anh em).
  const relFit = needRelFam ? (pool.relationship || []).filter((r) => relationshipFamily(r) === needRelFam) : [];
  bp.relationship = pickOne(relFit.length ? relFit : relCands) || '';
  // Pool khong co quan he nao thuoc nhom do -> bo rang buoc (khong de regen vo vong)
  bp.required_rel_family = relFit.length ? needRelFam : '';
  bp.hero_age = ageForTheme(extra, effTheme);

  // 4) ten (cooldown + ho chung neu gia dinh gan)
  // LOP 3: neu conflict/relationship chi ro gioi tinh vai thi ten PHAI khop gioi tinh do.
  // Giu nguyen conflict, chi random lai TEN. Khong suy ra duoc gioi -> tu do chon.
  const needG = requiredGenders(bp.conflict, bp.relationship);
  bp.required_hero_gender = needG.hero || '';
  bp.required_villain_gender = needG.villain || '';
  const heroPool = needG.hero
    ? (pool.hero_name || []).filter((n) => nameGender.gender(n) === needG.hero)
    : (pool.hero_name || []);
  const villainPool = needG.villain
    ? (pool.villain_name || []).filter((n) => nameGender.gender(n) === needG.villain)
    : (pool.villain_name || []);

  const surnames = extra.surname || [];
  const heroFirst = chooseWeighted(heroPool.length ? heroPool : (pool.hero_name || []), { country, field: 'hero_first', hardDays: nameRules.hero_name_cooldown_days || 60, wr });
  let villainFirst = chooseWeighted(villainPool.length ? villainPool : (pool.villain_name || []), { country, field: 'villain_first', hardDays: nameRules.villain_name_cooldown_days || 30, wr });
  if (villainFirst === heroFirst && nameRules.prevent_same_first_name_in_story) {
    const alt = (villainPool.length ? villainPool : (pool.villain_name || [])).filter((n) => n !== heroFirst);
    villainFirst = pickOne(alt) || villainFirst;
  }
  const heroSurname = surnames.length ? pickOne(surnames) : '';
  const villainSurname = (nameRules.same_surname_for_close_family && isCloseFamily(bp.relationship))
    ? heroSurname
    : (surnames.length ? pickOne(surnames) : '');
  bp.hero_first = heroFirst; bp.hero_surname = heroSurname; bp.hero_full_name = fullName(heroFirst, heroSurname);
  bp.villain_first = villainFirst; bp.villain_surname = villainSurname; bp.villain_full_name = fullName(villainFirst, villainSurname);

  // 5) location + town_setting (LOP 1: town phai hop GEOGRAPHY cua location) + season + weather
  bp.location = chooseWeighted(pool.location || [], { country, field: 'location', softDays: soft.location, wr }) || '';
  const towns = extra.town_setting || [];
  // LOP 1 v2: chi lay town HOP geography voi location (giu nguyen location).
  // town la khong biet -> 'generic' -> van phai giao voi state_geo, KHONG duoc cho qua.
  const townCands = towns.filter((t) => townCompatLocation(t, bp.location));
  bp.town_setting = townCands.length ? pickOne(townCands) : '';
  // season: uu tien theme preferred_events
  bp.season_event = pickOne((aff.preferred_events && aff.preferred_events.length) ? aff.preferred_events : (extra.season_event || [''])) || '';
  // weather: chi lay weather HOP season + HOP location; khong co -> de null (thà bỏ trống)
  const weatherCands = (extra.weather_mood || []).filter((w) => seasonWeatherOk(bp.season_event, w) && locationWeatherOk(bp.location, w));
  bp.weather_mood = weatherCands.length ? pickOne(weatherCands) : '';

  // ---- GUARD (2): 3 truong tra bang GEOGRAPHY phai co trong bang, khong duoc roi 'any' ----
  const HG = 'Bổ sung dòng tương ứng vào story-geography-US.json.';
  assertMapped('town_setting', bp.town_setting, townInTable(bp.town_setting), HG);
  assertMapped('season_event', bp.season_event, seasonInTable(bp.season_event), HG);
  assertMapped('weather_mood', bp.weather_mood, weatherInTable(bp.weather_mood), HG);

  // 6) occupation (affinity)
  bp.occupation = chooseWeighted(pool.occupation || [], { country, field: 'occupation', affinityKeywords: aff.preferred_occupations, affinityHard: true, softDays: soft.occupation, wr }) || '';

  // 7) icon_object (affinity, hard cooldown)
  bp.icon_object = chooseWeighted(pool.icon_object || [], { country, field: 'icon_object', affinityKeywords: aff.preferred_objects, affinityHard: true, hardDays: hard.icon_object, wr }) || '';

  // 8) opening_scene
  bp.opening_scene = chooseWeighted(pool.opening_scene || [], { country, field: 'opening_scene', softDays: soft.opening_scene, wr }) || '';

  // 9) humiliation_type
  bp.humiliation_type = pickOne(pool.humiliation_type || ['']) || '';

  // ---- LOP 2: family gan day (de tranh lap reveal_family + justice_family) ----
  const lastStory = memory.recentByCountry(country, 1)[0];
  const lastReveal = lastStory && lastStory.combo ? lastStory.combo.reveal_family : null;
  const lastJustice = lastStory && lastStory.combo ? lastStory.combo.justice_family : null;
  // combo lap nhieu nhat: external_public_validator + public_recognition -> cap <=25%
  const extcomboRate = memory.rateRecent(country, 20, (c) => c.reveal_family === 'external_public_validator' && c.justice_family === 'public_recognition').rate;
  const capExternal = extcomboRate >= 0.25; // combo lap nhieu nhat -> gioi han manh

  // 10) twist (reveal) — plot hidden-wealth + LOP2 family (tranh lap family bai truoc; cap external)
  const hwRate = memory.rateRecent(country, 20, (c) => isHiddenWealthTwist(c.twist)).rate;
  const excludeTwist = new Set();
  if (hwRate >= (plot.max_hidden_wealth_reveal_rate != null ? plot.max_hidden_wealth_reveal_rate : 0.2)) {
    for (const t of (pool.twist || [])) if (isHiddenWealthTwist(t)) excludeTwist.add(t);
  }
  const twistSoftFam = new Set(); if (lastReveal) twistSoftFam.add(lastReveal);
  const twistHardFam = new Set(); if (capExternal) twistHardFam.add('external_public_validator');
  // Cap 25% cho TUNG reveal_family (khong chi rieng cap external+public_recognition):
  // 5 bai lien tiep cung 'ordinary_witness' cung la lap, phai chan.
  // Cap 25% cho TUNG reveal_family. CHOT n>=2 (khong phai 4) -> cap co hieu luc NGAY o test nhanh
  //   (chi 2-3 bai). Truoc day n>=4 nen loat ngan khong bao gio cap -> external (60% pool) tran ngap.
  const REVEAL_CAP = 0.25;
  const REVEAL_FAMS = ['external_public_validator', 'ordinary_witness', 'document_evidence', 'self_disclosure'];
  const overCap = REVEAL_FAMS
    .map((fam) => ({ fam, r: memory.rateRecent(country, 20, (c) => c.reveal_family === fam) }))
    .filter((x) => x.r.n >= 2 && x.r.rate >= REVEAL_CAP)
    .sort((a, b) => b.r.rate - a.r.rate);
  // Chan toi da 2 nhom (nhieu nhat truoc) -> luon con it nhat 2 nhom de chon, khong bi ket
  for (const x of overCap.slice(0, 2)) twistHardFam.add(x.fam);
  // GOI Y tu subcategory (reveal_affinity) — chi la bonus, khong pha cooldown/cap
  const revBonus = new Set((input && input.reveal_affinity) || []);
  bp.twist = chooseWeighted(pool.twist || [], { country, field: 'twist', wr, exclude: excludeTwist, familyOf: revealFamily, softFamilies: twistSoftFam, hardFamilies: twistHardFam, bonusFamilies: revBonus }) || '';
  bp.reveal_type = bp.twist;
  bp.reveal_family = revealFamily(bp.twist);
  // Log ro khi pool BUOC PHAI NOI: chon ra 1 family da bi cap (vi cac nhom khac deu bi chan
  // hoac khong con twist phu hop) -> nguoi dung biet ly do lap.
  if (twistHardFam.has(bp.reveal_family)) {
    bp.reveal_cap_note = `pool reveal buộc nới — '${bp.reveal_family}' đang vượt cap ${Math.round(REVEAL_CAP * 100)}% nhưng các nhóm khác cạn twist phù hợp (pool twist lệch: 60% external)`;
  }

  // 11) justice_type — plot authority-rescue + LOP2 family (tranh lap; cap public_recognition khi external cao)
  const arRate = memory.rateRecent(country, 20, (c) => isAuthorityRescueJustice(c.justice_type)).rate;
  const excludeJust = new Set();
  if (arRate >= (plot.max_powerful_authority_rescue_rate != null ? plot.max_powerful_authority_rescue_rate : 0.25)) {
    for (const j of (pool.justice_type || [])) if (isAuthorityRescueJustice(j)) excludeJust.add(j);
  }
  const justSoftFam = new Set(); if (lastJustice) justSoftFam.add(lastJustice);
  const justHardFam = new Set();
  // neu vua chon reveal = external_public_validator VA combo external dang bi cap -> chan public_recognition
  if (bp.reveal_family === 'external_public_validator' && capExternal) justHardFam.add('public_recognition');
  const justBonus = new Set((input && input.justice_affinity) || []);
  bp.justice_type = chooseWeighted(pool.justice_type || [], { country, field: 'justice_type', softDays: soft.justice_type, wr, exclude: excludeJust, familyOf: justiceFamily, softFamilies: justSoftFam, hardFamilies: justHardFam, bonusFamilies: justBonus }) || '';
  bp.justice_family = justiceFamily(bp.justice_type);
  bp.relationship_family = relationshipFamily(bp.relationship);

  // ---- GUARD (1): 3 truong phan loai family PHAI tra duoc nhan ----
  const H = 'Khai nhãn trong pool.family_map hoặc bổ sung luật trong story-dna.js.';
  assertMapped('twist', bp.twist, bp.reveal_family, H);
  assertMapped('justice_type', bp.justice_type, bp.justice_family, H);
  assertMapped('relationship', bp.relationship, bp.relationship_family, H);

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
  bp.evidence_source = foundEv || (effTheme === 'D_vo_phan_boi' ? pickOne(EVID) : '');

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
function pickCombo(country, niche, nicheCode, { maxTries = 60, input = null } = {}) {
  const c = String(country || DEFAULT_COUNTRY).toUpperCase();
  const pool = poolAxes(c);
  const extra = poolExtra(c);
  const conf = conflictData(c);
  const cfg = engineConfig(c);
  // Theme: uu tien legacy_theme do LOP DAU VAO chi dinh (subcategory), khong co thi lay tu ngach cu
  const theme = (input && input.legacy_theme) ? input.legacy_theme : themeCodeOf(nicheCode, niche);

  if (!poolHasContent(pool)) {
    return { combo: {}, country: c, theme, tries: 0, regen: 0, fellBack: false, poolEmpty: true, valid: false, conflictBranch: '', hasConflict: false, signature: '' };
  }

  const sigHard = (extra.dedup_policy && extra.dedup_policy.hard_block_days && extra.dedup_policy.hard_block_days.story_signature) || 365;
  const last = memory.recentByCountry(c, 1)[0];
  const lastRF = last && last.combo ? last.combo.reveal_family : null;
  const lastJF = last && last.combo ? last.combo.justice_family : null;
  let tries = 0, regen = 0, lastReason = '';
  let bp = null, sig = '';
  while (tries < maxTries) {
    tries++;
    bp = buildOnce(c, theme, pool, extra, conf, cfg, input);
    // validate compatibility
    const comp = compatOk(bp, extra);
    if (!comp.ok) { regen++; lastReason = comp.reason; continue; }
    // LOP 2: KHONG cho 2 bai LIEN TIEP trung ca reveal_family + justice_family
    if (lastRF && bp.reveal_family === lastRF && bp.justice_family === lastJF) {
      regen++; lastReason = `trùng family bài trước (${lastRF} + ${lastJF})`; continue;
    }
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
    'BẮT BUỘC dùng ĐÚNG các yếu tố sau, KHÔNG đổi tên/vật/nút lật/QUAN HỆ/BỐI CẢNH:',
    `- hero_full_name = ${g('hero_full_name')} (tuổi ${g('hero_age')})`,
    `- villain_full_name = ${g('villain_full_name')}`,
    `- ⛔ relationship = ${g('relationship')} — KHÓA CỨNG. Nhân vật chính PHẢI đúng vai này (${g('relationship')}). KHÔNG đổi sang vai khác (vd caregiver, mother/son, con nuôi...) dù conflict text có nhắc vai khác.`,
    `- occupation = ${g('occupation')}`,
    `- ⛔ location = ${g('location')} | town = ${g('town_setting')} — KHÓA CỨNG. Câu chuyện PHẢI đặt tại ${g('location')} (${g('town_setting')}). KHÔNG chuyển sang bang/vùng khác. Trường "setting" trong DEDUP_CONFIG phải ghi đúng "${g('location')} — ${g('town_setting')}".`,
    `- dịp = ${g('season_event')} | không khí = ${g('weather_mood')}`,
    `- icon_object = ${g('icon_object')}`,
    `- opening_scene = ${g('opening_scene')}`,
    `- humiliation = ${g('humiliation_type')}`,
  ];
  if (bp && bp.conflict) {
    // Conflict lay tu fallback cap category thi KHONG ep buoc (tranh mau thuan voi premise
    // cua subcategory o khoi MANDATORY ben duoi) — chi coi la chat lieu tham khao.
    if (bp.conflict_scope === 'category' && bp.conflict_premise) {
      lines.push(`- conflict tham khảo (chỉ dùng nếu phù hợp với "Core conflict premise" bên dưới): ${bp.conflict}`);
    } else {
      lines.push(`- ⚠️ CONFLICT CHÍNH (BẮT BUỘC kể ĐÚNG tình huống này, KHÔNG đổi sang tình huống khác): ${bp.conflict}`);
    }
  }
  if (bp && bp.status_dynamic) lines.push(`- status_dynamic = ${bp.status_dynamic}`);
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

  // ---- KHOI BAT BUOC cua LOP DAU VAO (category/subcategory) — dat SAU khi da validate ----
  if (bp && bp.category_id) {
    const ctx = [bp.location, bp.town_setting, bp.season_event, bp.weather_mood].filter(Boolean).join(' / ');
    lines.push('');
    lines.push('MANDATORY STORY INPUT');
    lines.push(`- Category: ${bp.category_name || ''} (${bp.category_id})`);
    lines.push(`- Subcategory: ${bp.subcategory_name || ''} (${bp.subcategory_id || ''})`);
    lines.push(`- Core conflict premise: ${bp.conflict_premise || bp.conflict || ''}`);
    // status_dynamic: sac thai cang thang giai tang, ap xuyen category. CHI in khi co gia tri.
    if (bp.status_dynamic) lines.push(`- Class/status tension: ${bp.status_dynamic}`);
    lines.push(`- Relationship (LOCKED): ${bp.relationship || ''}`);
    lines.push(`- Location/town/season/weather (LOCKED): ${ctx}`);
    lines.push(`- Reveal family: ${bp.reveal_family || ''}`);
    lines.push(`- Justice family: ${bp.justice_family || ''}`);
    lines.push('');
    // Conflict text (legacy catalog) co the dung danh tu vai KHAC voi relationship da khoa
    // (vd conflict noi "the mother" nhung relationship la "grandmother"). Bao Claude anh xa
    // moi danh tu vai chung ve DUNG quan he da khoa, khong tao them nhan vat/quan he moi.
    if (bp.required_rel_family && bp.relationship) {
      lines.push(`ROLE MAPPING: The locked relationship is "${bp.relationship}". If the conflict text uses a different role word (e.g. "the mother", "the child", "the parent"), treat it as THIS locked relationship — do NOT introduce a different family role. Every character role in the story must fit "${bp.relationship}".`);
    }
    lines.push(`SETTING LOCK: The story MUST take place in ${bp.location}${bp.town_setting ? ' (' + bp.town_setting + ')' : ''}. Do NOT move it to another state or region. The DEDUP_CONFIG "setting" field must equal this location.`);
    if (bp.conflict_scope === 'category') {
      lines.push('NOTE: the reference conflict above is only a suggestion. If it does not fit the core conflict premise, ignore it and build the story from the premise.');
    }
    lines.push('You MUST tell the selected core conflict. Do not replace it with another family conflict. You may add secondary complications only if they support the selected conflict. The final story must remain classifiable under the selected category and subcategory.');
  }
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
    // LOP DAU VAO (ghi vao cot story_dna hien co, KHONG them cot Sheet moi)
    page_profile_id: c.page_profile_id || '',
    category_id: c.category_id || '',
    category_name: c.category_name || '',
    subcategory_id: c.subcategory_id || '',
    subcategory_name: c.subcategory_name || '',
    conflict_premise: c.conflict_premise || '',
    legacy_theme: c.legacy_theme || c.theme || '',
    status_dynamic: c.status_dynamic || '',
    theme: c.theme || theme || '',
    conflict_id: c.conflict_id || '',
    conflict: c.conflict || '',                 // TEXT conflict cuoi cung (sau validate)
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
    reveal_family: c.reveal_family || '',
    justice_family: c.justice_family || '',
    story_signature: c.story_signature || '',
  });
}

module.exports = {
  AXES, AXIS_KEYS, DEFAULT_COUNTRY,
  listCountries, getPool, savePool,
  pickCombo, buildDnaBlock, remember, comboToSheetJson, buildSignature, themeCodeOf,
  // phan loai (cho test)
  isAuthorityRescueJustice, isHiddenWealthTwist, isReconciliationEnding,
  townCompatLocation, seasonWeatherOk, locationWeatherOk, geoOfState, geoOfTown, geoComboOk,
  requiredGenders, requiredRelFamily, compatOk,
  classifyReveal, classifyJustice, classifyRelationship, poolFamilyOf,
  revealFamily, justiceFamily, relationshipFamily,
};
