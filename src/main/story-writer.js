'use strict';

/**
 * BO NAO viet truyen "Justice Fantasy" cho phu nu My 55-75, thay cho translator.js cu.
 *
 *  - KHONG dich. KHONG can link. Skill tu sinh chu de.
 *  - Dieu khien Claude WEB (login, khong API) qua webai-electron.js.
 *  - Goi skill "story-us-senior-viral" da Save trong tai khoan Claude (Cach 1 - gon).
 *  - Nhan ket qua theo khuon ===COT=== (3 cot cuoi la JSON: dedup_config, story_dna, kpi_scores).
 *  - Tach thanh 21 cot dung thu tu Google Sheet -> n8n cao dung.
 *  - Tao anh (Cloudflare Workers AI - FLUX 2 klein-9b) + up R2, chen link vao web_body.
 *    Loi anh khong lam sap bai. Prompt anh LAY NGUYEN tu cot skill da viet (khong tu che).
 *
 * Ket qua 1 bai: { row: [21 o], raw: '<van ban Claude tra ve>', sections, storyId, status }
 */

const store = require('./store');
const webai = require('./webai-electron');
const imageGen = require('./image-gen');
const imageRouter = require('./image-router');
const storyDna = require('./story-dna');
const storyCategory = require('./story-category');
const memory = require('./story-memory');

// ---- Cac NGACH mac dinh (page target). Nguoi dung sua duoc trong Cai dat. ----
const DEFAULT_NICHES = [
  { code: 'A', label: 'Mẹ già – con bạc bẽo' },
  { code: 'B', label: 'Cựu chiến binh bị coi thường' },
  { code: 'C', label: 'Cô dâu mới – nhà chồng chà đạp' },
  { code: 'D', label: 'Vợ bị phản bội – nắm bằng chứng' },
  { code: 'E', label: 'Người nghèo tử tế vs họ hàng giàu' },
];

// Cac COT xuat ra Google Sheet (22 cot) - PHAI khop HEADER trong Apps Script (docs/GOOGLE-SHEETS-SETUP.md)
//  S(19)=dedup_config  T(20)=reveal_config  U(21)=kpi_scores  V(22)=story_dna (bo DNA day du)
const SHEET_COLUMNS = [
  'story_id', 'timestamp', 'status', 'page_target', 'web_title', 'web_slug', 'web_body',
  'fb_caption_a', 'fb_caption_b', 'fb_cta', 'fb_comment_link', 'web_url',
  'fb_image_url', 'thumbnail_url', 'fb_image_prompt', 'web_p1_prompt', 'web_p2_prompt', 'web_p3_prompt',
  'dedup_config', 'reveal_config', 'kpi_scores', 'story_dna',
];

// ---- Khuon JSON mac dinh cho cac cot JSON (dam bao du khoa ke ca khi Claude tra thieu) ----
const DEDUP_TEMPLATE = { victim: '', villain: '', theme: '', emotion: '', justice: '', object: '', setting: '', ending: '' };
// reveal_config (cot T) - truoc day dat nham ten story_dna
const REVEAL_TEMPLATE = { reveal: '', reveal_source: '', object: '', justice: '' };
const KPI_TEMPLATE = { hook: 0, facebook_ctr: 0, justice: 0, empathy: 0, novelty: 0, american: 0, final: 0 };

// Cau lenh goi skill - MAC DINH (Cach 1). Nguoi dung sua duoc trong Cai dat (tuy bien).
// {NICHE} duoc thay bang "<category_name> — <subcategory_name>" tu LOP DAU VAO
// (KHONG con la ngach A-E cu) -> Claude chi nhan MOT nguon chi dan ve chu de,
// khong mau thuan voi khoi MANDATORY STORY INPUT. Skill tu chay pipeline 11 buoc.
const DEFAULT_SKILL_COMMAND =
  `/story-us-senior-viral viết truyện Mỹ 55+ theo chủ đề "{NICHE}".

Chạy đầy đủ pipeline tự động (tự sinh idea, 20 hook, chấm KPI, đóng vai độc giả 55-75 chọn hook, viết caption A/B, viết bài web Part 1/2/3, 7 reviewer, adaptive threshold). Chống lặp với các bài đã sinh.

QUAN TRỌNG — xuất kết quả theo ĐÚNG khuôn nhãn dưới đây để phần mềm bóc tách (mỗi nhãn 1 dòng riêng, KHÔNG lời dẫn thừa). Ba nhãn cuối (DEDUP_CONFIG, STORY_DNA, KPI_SCORES) phải là JSON hợp lệ đúng khoá như mẫu.

===WEB_TITLE===
<tiêu đề web SEO, dài, nhồi twist, tiếng Anh>
===WEB_SLUG===
<đường dẫn url chữ thường gạch ngang, tiếng Anh>
===WEB_BODY===
<Toàn bộ bài web gộp 3 Part trong 1 bài, xuất HTML tiếng Anh Mỹ. Mỗi part mở đầu bằng <h2>Part 1 — tên part</h2> rồi các đoạn <p>...</p>. CHÈN đúng 3 ảnh, mỗi part 1 ảnh, đặt giữa part đúng ngữ cảnh, dạng: <img src="{{IMG_P1}}" alt="mô tả có keyword SEO"> cho Part 1, {{IMG_P2}} cho Part 2, {{IMG_P3}} cho Part 3. GIỮ NGUYÊN các chuỗi {{IMG_P1}} {{IMG_P2}} {{IMG_P3}} — phần mềm sẽ thay bằng link ảnh thật.>
===FB_CAPTION_A===
<caption Facebook bản A dài ~600-900 từ, cắt cliffhanger>
===FB_CAPTION_B===
<caption Facebook bản B ngắn ~300-400 từ, đấm nhanh>
===FB_CTA===
<câu CTA kiểu "Type YES...", KHÔNG kèm link>
===FB_IMAGE_PROMPT===
<Prompt ảnh mồi Facebook, TIẾNG ANH, theo công thức Human Conflict 3 lớp: khuôn mặt nhân vật chính là trung tâm, kẻ gây bất công, người chứng kiến, và một vật biểu tượng phụ. KHÔNG spoil twist/reveal. Kết thúc BẮT BUỘC bằng đúng câu: Square 1:1, restrained emotion, natural facial expressions, believable body language, not theatrical, no text, no watermark>
===THUMB_PROMPT===
<Prompt ảnh THUMBNAIL WEB NGANG (16:9), TIẾNG ANH, tối ưu CTR. Cùng phong cách candid/documentary và "cú tát" cảm xúc như ảnh FB nhưng BỐ CỤC NGANG: khoảnh khắc cao trào nhất, khuôn mặt nhân vật rõ, có khoảng trống hai bên cho bố cục ngang. KHÔNG spoil twist. Kết thúc BẮT BUỘC bằng: Horizontal 16:9, candid documentary photo, natural available light, authentic skin texture, restrained emotion, not cinematic, no text, no watermark>
===WEB_P1_PROMPT===
<Prompt ảnh minh hoạ Part 1, TIẾNG ANH, đúng ngữ cảnh Part 1, cinematic, 16:9 aspect ratio, no text>
===WEB_P2_PROMPT===
<Prompt ảnh minh hoạ Part 2, TIẾNG ANH, đúng ngữ cảnh Part 2, cinematic, 16:9 aspect ratio, no text>
===WEB_P3_PROMPT===
<Prompt ảnh minh hoạ Part 3, TIẾNG ANH, đúng ngữ cảnh Part 3, cinematic, 16:9 aspect ratio, no text>
===DEDUP_CONFIG===
{"victim":"","villain":"","theme":"","emotion":"","justice":"","object":"","setting":"","ending":""}
===STORY_DNA===
{"reveal":"","reveal_source":"","object":"","justice":""}
===KPI_SCORES===
{"hook":0,"facebook_ctr":0,"justice":0,"empathy":0,"novelty":0,"american":0,"final":0}
===END===`;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Cac NHAN hop le ma skill co the tra ve (dung lam DANH SACH TRANG -> tranh nhan nham
// mot dong trong bai thanh nhan). Co ca ten CU de con doc duoc ket qua skill ban truoc.
const KNOWN_KEYS = [
  'WEB_TITLE', 'WEB_SLUG', 'WEB_BODY',
  'FB_CAPTION_A', 'FB_CAPTION_B', 'FB_CTA',
  'FB_IMAGE_PROMPT', 'THUMB_PROMPT', 'WEB_P1_PROMPT', 'WEB_P2_PROMPT', 'WEB_P3_PROMPT',
  'DEDUP_CONFIG', 'STORY_DNA', 'KPI_SCORES', 'END',
  'WEB_IMAGE_PROMPT', 'REVEAL_TYPE', // ten cu
  'QA_REPORT', 'TITLE', 'CTA',       // skill QA tieu de (chay o buoc 2)
  'COLD_OPEN', 'HOOK_VARIANTS',      // cold open viet lai (buoc 2c) + hook variants (tuy chon)
];

// Chuan hoa chuoi nhan: hoa het, khoang trang/gach ngang -> gach duoi, bo ky tu la
function normKey(s) {
  return String(s || '').toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
}

// Bo lop trang tri markdown quanh dong (#, **, -, khoang trang, dau hai cham cuoi)
function stripDecor(line) {
  return String(line)
    .replace(/^\s*#{1,6}\s*/, '')      // ## tieu de
    .replace(/^\s*[-*]\s+/, '')        // gach dau dong
    .replace(/\*\*/g, '')              // in dam
    .replace(/\s*:\s*$/, '')           // dau hai cham cuoi
    .trim();
}

// Du phong: dong CHI chua ten nhan (co the boc [ ] hoac markdown), vd "WEB_BODY", "[WEB_BODY]", "## WEB_BODY:"
function matchBareHeader(line) {
  const s = stripDecor(line).replace(/^\[\s*|\s*\]$/g, '').trim();
  if (!s || s.length > 40) return null;
  const k = normKey(s);
  return KNOWN_KEYS.includes(k) ? k : null;
}

// Mau nhan ===KEY=== o BAT KY dau nao (KHONG neo dong). Day la mau chot sua bug
// "noi dung khoi nay nuot nhan cua khoi sau" khi Claude viet nhan cung dong voi noi dung.
const LABEL_ANYWHERE = /={2,}[ \t]*([A-Za-z0-9 _-]{2,40}?)[ \t]*={2,}/g;

/**
 * Don sach 1 khoi noi dung sau khi cat:
 *  - bo dong ```fence```
 *  - bo MOI nhan ===...=== con sot (dau/cuoi/giua dong)
 *  - bo khoang trang, xuong dong, rac markdown thua o hai dau
 * HTML ben trong duoc giu nguyen.
 */
function cleanBlock(s) {
  let out = String(s == null ? '' : s);
  // bo dong fence
  out = out.split(/\r?\n/).filter((l) => !l.trim().startsWith('```')).join('\n');
  // bo moi nhan ===...=== con sot o bat ky vi tri nao
  out = out.replace(LABEL_ANYWHERE, '');
  // bo dau bang tho con lai lac lo tren dong rieng (vd "======")
  out = out.split(/\r?\n/).filter((l) => !/^\s*[*#\s]*={2,}[*#\s]*$/.test(l)).join('\n');
  // don rac markdown/khoang trang o hai dau (khong dung toi noi dung HTML)
  out = out.replace(/^(?:\s|\*{1,2}|#{1,6})+/, '').replace(/(?:\s|\*{1,2}|#{1,6})+$/, '');
  return out.trim();
}

/**
 * Cat khoi theo nhan ===KEY=== bang cach quet TOAN VAN BAN.
 * Noi dung 1 khoi = doan tu NGAY SAU nhan cua no toi NGAY TRUOC nhan hop le ke tiep
 * -> ve cau truc KHONG THE nuot nhan cua khoi sau.
 */
function collectByLabel(text) {
  const src = String(text || '');
  const hits = [];
  LABEL_ANYWHERE.lastIndex = 0;
  let m;
  while ((m = LABEL_ANYWHERE.exec(src)) !== null) {
    const k = normKey(m[1]);
    if (KNOWN_KEYS.includes(k)) hits.push({ key: k, start: m.index, end: LABEL_ANYWHERE.lastIndex });
  }
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.key === 'END') continue;
    const next = hits[i + 1];                       // nhan hop le KE TIEP (bat ky nhan nao)
    const body = cleanBlock(src.slice(h.end, next ? next.start : src.length));
    // giu lan xuat hien DAU TIEN co noi dung (tranh nhan lap lam mat du lieu)
    if (out[h.key] === undefined || (!out[h.key] && body)) out[h.key] = body;
  }
  return out;
}

// Du phong (khi khong co nhan ===): cat theo dong, cung don sach bang cleanBlock
function collectByLine(text, matcher) {
  const map = {};
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const key = matcher(raw);
    if (key) { cur = key; if (cur !== 'END' && !map[cur]) map[cur] = []; continue; }
    if (cur && cur !== 'END') map[cur].push(raw);
  }
  const out = {};
  for (const k of Object.keys(map)) out[k] = cleanBlock(map[k].join('\n'));
  return out;
}

/**
 * Doc output cua Claude. Uu tien khuon ===KEY=== (quet toan van ban); neu khong ra
 * du nhan thi thu kieu nhan tran ("WEB_BODY" / "[WEB_BODY]" / "## WEB_BODY").
 * HTML trong web_body duoc giu nguyen (chi bo dong ```fence``` va nhan lot).
 */
function parseSections(text) {
  const a = collectByLabel(text);
  const countA = Object.keys(a).length;
  if (countA >= 3) return a;                       // khuon chuan chay tot -> dung luon
  const b = collectByLine(text, matchBareHeader);  // du phong
  return Object.keys(b).length > countA ? b : a;
}

/**
 * Kiem tra cuoi: khoi nao VAN con chuoi '===' la dau hieu lot nhan -> tra ve canh bao
 * (ghi vao last-run.json de phat hien som, tranh AI tao anh doc nham nhan).
 */
function checkLeakedLabels(sections) {
  const warnings = [];
  for (const k of Object.keys(sections || {})) {
    const v = sections[k];
    if (typeof v === 'string' && v.includes('===')) {
      warnings.push(`${k.toLowerCase()} còn chứa === (có thể lọt nhãn khối khác)`);
    }
  }
  return warnings;
}

// Cac mang BAT BUOC phai co de luu duoc bai
const REQUIRED = [
  { key: 'WEB_TITLE', label: 'WEB_TITLE (tiêu đề)' },
  { key: 'WEB_BODY', label: 'WEB_BODY (nội dung bài)', minLen: 300 },
  { key: 'FB_CAPTION_A', label: 'FB_CAPTION_A (caption A)' },
  { key: 'FB_CAPTION_B', label: 'FB_CAPTION_B (caption B)' },
];

// Tra ve DANH SACH CU THE cac mang bi thieu (kem ly do), thay vi bao chung chung
function missingSections(s) {
  const missing = [];
  for (const r of REQUIRED) {
    const v = (s && s[r.key]) ? String(s[r.key]).trim() : '';
    if (!v) { missing.push(r.label + ' — KHÔNG có'); continue; }
    if (r.minLen && v.length < r.minLen) missing.push(`${r.label} — quá ngắn (${v.length} ký tự, cần ≥ ${r.minLen})`);
  }
  return missing;
}

// Chuan hoa 1 doan text thanh JSON string DUNG KHOA theo template.
// Neu Claude tra JSON hong/thieu -> van dam bao du khoa (dien mac dinh), tra chuoi JSON gon.
function normalizeJson(text, template, numeric = false) {
  const t = String(text || '').trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (_) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (_) { /* van null */ } }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  const out = {};
  for (const k of Object.keys(template)) {
    let v = obj[k] !== undefined ? obj[k] : template[k];
    if (numeric) { const n = Number(v); v = Number.isFinite(n) ? n : 0; }
    out[k] = v;
  }
  return JSON.stringify(out);
}

// KPI ve thang 0-100. Neu skill tra thang 10 (moi diem <=10) -> tu nhan 10.
function normalizeKpi(text) {
  const parsed = JSON.parse(normalizeJson(text, KPI_TEMPLATE, true)); // -> so
  const keys = Object.keys(KPI_TEMPLATE);
  const max = Math.max(0, ...keys.map((k) => Number(parsed[k]) || 0));
  const scale = (max > 0 && max <= 10) ? 10 : 1;   // thang 10 -> x10; da 0-100 -> giu
  const out = {};
  for (const k of keys) {
    let v = Math.round((Number(parsed[k]) || 0) * scale);
    if (v < 0) v = 0; if (v > 100) v = 100;
    out[k] = v;
  }
  return JSON.stringify(out);
}

// Thay placeholder {{IMG_Px}} trong web_body:
//  - co link  -> thay bang link that (giu the <img>)
//  - khong co -> xoa CA the <img ...{{IMG_Px}}...> (tranh de lai src rong / token tho)
function applyImagePlaceholders(html, urls) {
  let out = String(html || '');
  const map = { '{{IMG_P1}}': urls.p1, '{{IMG_P2}}': urls.p2, '{{IMG_P3}}': urls.p3 };
  for (const token of Object.keys(map)) {
    const url = map[token];
    if (url) {
      out = out.split(token).join(url);
    } else {
      // xoa the img chua token; neu khong nam trong the img thi xoa token tho
      const tokEsc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('<img\\b[^>]*' + tokEsc + '[^>]*>', 'gi'), '');
      out = out.split(token).join('');
    }
  }
  return out;
}

// Doc cau hinh anh (Cloudflare Workers AI + R2) tu store, GIAI MA secret.
function getImageConfig() {
  let s = {};
  try { s = store.read('settings.json'); } catch (_) { s = {}; }
  const img = s.image || {};
  const dec = (v) => { try { return store.decryptSecret(v); } catch (_) { return ''; } };
  const src = img.source || {};
  return {
    cfAccountId: dec(img.cfAccountId),
    cfApiToken: dec(img.cfApiToken),
    r2AccessKeyId: dec(img.r2AccessKeyId),
    r2SecretAccessKey: dec(img.r2SecretAccessKey),
    r2Endpoint: (img.r2Endpoint || '').trim(),
    r2Bucket: (img.r2Bucket || '').trim(),
    r2PublicDomain: (img.r2PublicDomain || '').trim(),
    // Nguon tao anh + thu tu uu tien + bat/tat + hien cua so
    source: {
      order: Array.isArray(src.order) && src.order.length ? src.order : imageRouter.DEFAULT_ORDER,
      enabled: src.enabled || imageRouter.DEFAULT_ENABLED,
      showWindow: !!src.showWindow,
    },
  };
}

// "San sang" = co R2 + it nhat 1 nguon anh duoc bat. (Nguon web con can dang nhap,
// nhung do kiem tra o luc tao; thieu login -> anh loi -> need_image, khong sap bai.)
function imageConfigReady(cfg) {
  const r2 = !!(cfg.r2Endpoint && cfg.r2AccessKeyId && cfg.r2SecretAccessKey && cfg.r2Bucket && cfg.r2PublicDomain);
  const anySource = imageRouter.orderedSources(cfg).length > 0;
  return r2 && anySource;
}

// Nuoc dang chay (mac dinh US). Nguoi dung chon trong Cai dat -> Story DNA.
function getRunningCountry() {
  try {
    const s = store.read('settings.json');
    const c = s.dna && s.dna.runningCountry;
    return (c ? String(c) : storyDna.DEFAULT_COUNTRY).toUpperCase();
  } catch (_) { return storyDna.DEFAULT_COUNTRY; }
}

// Nguon dau vao category: auto (theo page profile) | category | subcategory (manual override)
function getInputSelection() {
  try {
    const s = store.read('settings.json');
    const i = (s.story && s.story.input) || {};
    return {
      mode: i.mode || 'auto',
      pageId: i.pageId || 'P01',
      categoryId: i.categoryId || '',
      subcategoryId: i.subcategoryId || '',
      fastTest: !!i.fastTest,
    };
  } catch (_) { return { mode: 'auto', pageId: 'P01', categoryId: '', subcategoryId: '', fastTest: false }; }
}

// Cau lenh skill goc. Co the tuy bien chung (settings.story.skillCommand) hoac
// RIENG theo nuoc (settings.dna.skillByCountry[COUNTRY]) - de sau nay moi nuoc 1 skill.
// Mac dinh: /story-us-senior-viral cho US (DEFAULT_SKILL_COMMAND).
function getSkillTemplate(country) {
  let s = {};
  try { s = store.read('settings.json'); } catch (_) {}
  const perCountry = s.dna && s.dna.skillByCountry && s.dna.skillByCountry[String(country).toUpperCase()];
  if (perCountry && String(perCountry).trim()) return perCountry;
  const saved = s.story && s.story.skillCommand;
  // Bo sung THUMB_PROMPT: template cu thieu nhan moi -> tu dung DEFAULT moi
  const usable = saved && saved.includes('WEB_P1_PROMPT') && saved.includes('STORY_DNA') && saved.includes('THUMB_PROMPT');
  return usable ? saved : DEFAULT_SKILL_COMMAND;
}

// ---- QA TIEU DE (skill thu 2 chay TRONG CUNG doan chat, doc bai o tren) ----
const DEFAULT_QA_COMMAND = '/story-title-qa';
// Bat/tat + cau lenh QA (co the tuy bien). Mac dinh BAT.
function getQaConfig() {
  let s = {};
  try { s = store.read('settings.json'); } catch (_) {}
  const st = s.story || {};
  const enabled = !(st.titleQa === false);                 // mac dinh true
  const cmd = (typeof st.qaCommand === 'string' && st.qaCommand.trim()) ? st.qaCommand.trim() : DEFAULT_QA_COMMAND;
  return { enabled, command: cmd };
}

// ==================== KIEM TIEU DE BANG CODE (thay QA skill tu cham) ====================
// Claude khong tu cham duoc tieu de cua chinh no (tieu de 28 tu lo ket van bao "dat").
// -> dung LUAT CO DINH: <=20 tu + khong chua cum lo ket.
const TITLE_MAX_WORDS = 20;
const RESCUER_NOUNS = ['colonel', 'general', 'judge', 'doctor', 'sergeant', 'captain', 'officer', 'novelist', 'celebrity', 'stranger', 'detective', 'veteran'];
const ENDING_PHRASES = ['stood up', 'said her name', 'said his name', 'told everyone', 'the whole town', 'changed everything', 'who she really was', 'who he really was', 'really been', 'revealed', 'exposed', 'learned the truth'];
function reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function titleWordCount(t) { return String(t || '').trim().split(/\s+/).filter(Boolean).length; }
// Tra ve CUM lo ket dau tien tim thay (giu nguyen chu goc de bao loi), '' neu sach.
function findTitleLeak(title) {
  const t = String(title || '');
  // a) "then/until a|an|the" dau tieu de HOAC sau dau gach ngang / cham
  let m = t.match(/(^|[—–\-.:;]\s*)\b(then|until)\s+(a|an|the)\b/i);
  if (m) return (m[2] + ' ' + m[3]);
  // b) danh tu nguoi den cuu sau a|an|the
  m = t.match(new RegExp('\\b(a|an|the)\\s+(' + RESCUER_NOUNS.join('|') + ')\\b', 'i'));
  if (m) return m[0];
  // c) cum canh ket
  for (const p of ENDING_PHRASES) {
    const mm = t.match(new RegExp('\\b' + reEsc(p) + '\\b', 'i'));
    if (mm) return mm[0];
  }
  return '';
}
function checkTitle(title) {
  const words = titleWordCount(title);
  const leak = findTitleLeak(title);
  return { ok: words <= TITLE_MAX_WORDS && !leak, words, leak };
}
// Tu cat khi het luot viet lai:
//  1) giu phan TRUOC dau gach ngang / cham dau tien
//  2) neu VAN con cum lo ket -> cat ngay TRUOC cum do (tieu de lo thuong khong co dau ngan cach)
//  3) cat con <=20 tu
function truncateTitle(title) {
  const cap = (s) => { const w = String(s || '').trim().split(/\s+/).filter(Boolean); return (w.length > TITLE_MAX_WORDS ? w.slice(0, TITLE_MAX_WORDS) : w).join(' '); };
  let t = String(title || '').trim();
  const cut = t.search(/\s[—–-]\s|[—–]|\.(?:\s|$)/);
  if (cut > 0) t = t.slice(0, cut);
  const dashCut = cap(t.trim().replace(/[\s.,;:—–-]+$/, ''));  // phuong an giu lai neu cat lo ket ra rong
  // con lo ket -> cat truoc vi tri cum do (giu phan mo dau, bo phan he lo)
  let guard = 0, leak = findTitleLeak(t);
  while (leak && guard++ < 6) {
    const idx = t.toLowerCase().indexOf(leak.toLowerCase());
    if (idx <= 0) { t = ''; break; }
    t = t.slice(0, idx).trim().replace(/[\s.,;:—–-]+$/, '').trim();
    leak = findTitleLeak(t);
  }
  t = cap(t.trim().replace(/[\s.,;:—–-]+$/, ''));
  // KHONG de rong: cum lo nam ngay dau -> giu phan truoc dau gach/cham (<=20 tu), chap nhan con lo.
  return t || dashCut || cap(title);
}
function titleRewritePrompt(words, leak) {
  const leakClause = leak ? `và chứa cụm lộ kết: "${leak}"` : '(vượt giới hạn độ dài)';
  return `Tiêu đề vừa rồi có ${words} từ (giới hạn 20) ${leakClause}.
Viết lại tiêu đề theo đúng khuôn sau, KHÔNG thêm gì:
- Chỉ nêu sự xúc phạm cụ thể xảy ra ở đầu truyện.
- Dừng lại ngay tại đó. Không "Then", không "Until", không nói ai xuất hiện, không nói kết cục.
- Tối đa 20 từ.
Ví dụ đúng: "They Made Her Use the Side Door So the Guests Wouldn't See the Bus Driver"
Chỉ xuất: ===TITLE=== rồi tiêu đề mới.`;
}

// ==================== KIEM COLD OPEN (dau web_body) BANG CODE ====================
// Skill yeu cau mo bai bang 3-4 dong ngan dam thang; Claude hay mo bang doan van dai ta canh.
const COLD_FIRST_MAX = 40;      // <p> dau tien > 40 tu -> khong phai cold open
const COLD_THREE_MAX = 120;     // 3 doan dau cong lai > 120 tu -> qua dai
const COLD_P45_MAX = 60;        // doan 4 va 5 moi doan > 60 tu -> nhip khung (Claude ta canh o doan 4)
function wc(html) { return wordCount(html); }  // dung lai bo dem tu (bo the HTML)
// Lay noi dung cac the <p> dau tien SAU <h2>Part 1...</h2> (hoac dau bai neu khong co h2).
function firstParagraphs(html, n) {
  let src = String(html || '');
  const h2 = src.search(/<h2[^>]*>\s*part\s*1\b/i);
  if (h2 >= 0) { const close = src.indexOf('</h2>', h2); src = src.slice(close >= 0 ? close + 5 : h2); }
  const ps = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(src)) !== null && ps.length < n) ps.push(m[1]);
  return ps;
}
function checkColdOpen(html) {
  const ps = firstParagraphs(html, 5);
  if (!ps.length) return { ok: true, first: 0, three: 0, p4: 0, p5: 0, note: 'khong thay <p> dau -> bo qua' };
  const first = wc(ps[0]);
  const three = ps.slice(0, 3).reduce((a, p) => a + wc(p), 0);
  const p4 = ps[3] ? wc(ps[3]) : 0;
  const p5 = ps[4] ? wc(ps[4]) : 0;
  const reasons = [];
  if (first > COLD_FIRST_MAX) reasons.push(`đoạn đầu ${first} từ (>${COLD_FIRST_MAX})`);
  if (three > COLD_THREE_MAX) reasons.push(`3 đoạn đầu ${three} từ (>${COLD_THREE_MAX})`);
  if (p4 > COLD_P45_MAX) reasons.push(`đoạn 4 ${p4} từ (>${COLD_P45_MAX})`);
  if (p5 > COLD_P45_MAX) reasons.push(`đoạn 5 ${p5} từ (>${COLD_P45_MAX})`);
  return { ok: reasons.length === 0, first, three, p4, p5, reason: reasons.join('; ') };
}
function coldOpenRewritePrompt(info) {
  const first = (typeof info === 'number') ? info : (info && info.first) || 0;
  const detail = (info && typeof info === 'object' && info.reason) ? info.reason : `đoạn đầu ${first} từ`;
  return `Phần mở đầu Part 1 chưa đạt (${detail}) — nhịp bị khựng ngay khi vừa kéo người đọc vào.
Viết lại 5 dòng MỞ ĐẦU cho Part 1, mỗi dòng một thẻ <p>:
- Dòng 1 (dưới 35 từ): sự xúc phạm cụ thể (câu thoại hoặc hành động), KHÔNG tả thời tiết/căn phòng.
- Dòng 2 (dưới 35 từ): phản ứng im lặng của nhân vật.
- Dòng 3 (dưới 35 từ): dấu hiệu sắp có chuyện — KHÔNG nói ai xuất hiện, KHÔNG nói chuyện gì, KHÔNG nói kết cục.
- Dòng 4 (dưới 60 từ): MỘT câu chuyển tiếp ngắn dẫn vào mạch kể chậm — KHÔNG phải đoạn tả cảnh đầy đủ.
- Dòng 5 (dưới 60 từ): câu chuyển tiếp ngắn thứ hai, bắt đầu vào hồi tưởng/bối cảnh.
Mẫu 3 dòng đầu:
<p>They told the seventy-three-year-old bus driver to use the side door so the guests would not see her.</p>
<p>She carried in the food, said nothing, and took her usual place near the kitchen.</p>
<p>Twenty minutes later, one man stood up — and the expression on her grandson's face told her everything she needed to know.</p>
Chỉ xuất: ===COLD_OPEN=== rồi đúng 5 thẻ <p>. Không viết lại phần còn lại của bài.`;
}
// Chen cold open MOI vao ngay sau <h2>Part 1...</h2> (hoac dau bai). Giu nguyen phan con lai.
function insertColdOpen(html, coldOpen) {
  const co = String(coldOpen || '').trim();
  if (!co) return html;
  let src = String(html || '');
  const h2 = src.search(/<h2[^>]*>\s*part\s*1\b/i);
  if (h2 >= 0) {
    const close = src.indexOf('</h2>', h2);
    const at = close >= 0 ? close + 5 : h2;
    return src.slice(0, at) + '\n' + co + '\n' + src.slice(at);
  }
  return co + '\n' + src;                       // khong co h2 -> chen dau bai
}

// ==================== KIEM CTA BANG CODE ====================
// CTA phai keo click ve web, KHONG doi comment/type YES, KHONG lo nguoi/vat se xuat hien.
const CTA_BEG_PHRASES = ['type yes', 'comment yes', 'write yes', 'type ja', 'say yes', 'drop a yes', 'comment below to', 'for part 2', 'part two'];
const CTA_SPOIL_PHRASES = ['what the man', 'what the woman', 'what he said next', 'what she said next', 'the man in the', 'the woman in the', 'who walked in', 'who stood up'];
const CTA_SAFE_DEFAULT = 'The rest of the story is in the first comment.';
function checkCta(cta) {
  const s = String(cta || '').toLowerCase();
  const beg = CTA_BEG_PHRASES.find((p) => s.includes(p));
  const spoil = CTA_SPOIL_PHRASES.find((p) => s.includes(p));
  const reasons = [];
  if (beg) reasons.push(`đòi tương tác: "${beg}"`);
  if (spoil) reasons.push(`lộ nội dung sau: "${spoil}"`);
  return { ok: !beg && !spoil, beg: beg || '', spoil: spoil || '', reason: reasons.join('; ') };
}
function ctaRewritePrompt(reason) {
  return `CTA vừa rồi vi phạm: ${reason}.
Viết lại CTA theo đúng khuôn:
- MỘT câu ngắn mời đọc tiếp ở link, KHÔNG đòi comment/type YES.
- KHÔNG nói ai sẽ xuất hiện, KHÔNG nói chuyện gì xảy ra tiếp.
- Chỉ được hứa mơ hồ MỘT điều.
Mẫu đúng: "The rest of what happened that morning is in the first comment."
Mẫu đúng: "What she did next is in the link below."
Chỉ xuất: ===CTA=== rồi CTA mới.`;
}

// Dung prompt cuoi = KHOI DNA (bat buoc dung to hop) + cau lenh goi skill.
// @param dna { combo, country } da chon san (co the null -> khong nhet DNA)
// @param topicLabel chu de gui cho Claude: "<category_name> — <subcategory_name>"
//   (khi lop category loi -> fallback ve ten ngach cu)
function buildPrompt(topicLabel, dna) {
  const country = (dna && dna.country) || getRunningCountry();
  const tmpl = getSkillTemplate(country).replace(/\{NICHE\}/g, topicLabel);
  if (dna && dna.combo) {
    return storyDna.buildDnaBlock(dna.combo, country) + '\n' + tmpl;
  }
  return tmpl;
}

// Ghep 1 bai thanh 21 o dung thu tu SHEET_COLUMNS.
// @param extra { storyId, status, webBody, fbImageUrl, thumbnailUrl }
function buildRow(nicheLabel, s, extra = {}) {
  const now = new Date().toLocaleString('vi-VN');
  const map = {
    story_id: extra.storyId || '',
    timestamp: now,
    status: extra.status || 'new',                   // n8n nhin cot nay biet bai chua dang / can tao lai anh
    // Cot D: dinh danh PAGE tu lop category, dang "P01 — Grandparent Stories"
    // (n8n route bang cach lay ma P01 o dau chuoi). Khi lop category loi -> "FALLBACK — <ngach cu>".
    page_target: extra.pageTarget || nicheLabel,
    web_title: s.WEB_TITLE || '',
    web_slug: s.WEB_SLUG || '',
    web_body: extra.webBody != null ? extra.webBody : (s.WEB_BODY || ''),
    fb_caption_a: s.FB_CAPTION_A || '',
    fb_caption_b: s.FB_CAPTION_B || '',
    fb_cta: s.FB_CTA || '',
    fb_comment_link: '[LINK]',                        // n8n dien link web sau khi dang
    web_url: '',                                      // n8n dien sau khi dang WordPress
    fb_image_url: extra.fbImageUrl || '',
    thumbnail_url: extra.thumbnailUrl || '',          // dung chung link anh fb
    fb_image_prompt: s.FB_IMAGE_PROMPT || '',
    web_p1_prompt: s.WEB_P1_PROMPT || '',
    web_p2_prompt: s.WEB_P2_PROMPT || '',
    web_p3_prompt: s.WEB_P3_PROMPT || '',
    dedup_config: normalizeJson(s.DEDUP_CONFIG, DEDUP_TEMPLATE),                 // cot S (19)
    reveal_config: normalizeJson(s.STORY_DNA, REVEAL_TEMPLATE),                  // cot T (20) - reveal/reveal_source/object/justice
    kpi_scores: normalizeKpi(s.KPI_SCORES),                                       // cot U (21) - thang 0-100
    // cot V (22): bo DNA day du (JSON) App gan san
    story_dna: extra.dnaCombo != null ? extra.dnaCombo : '',
  };
  return SHEET_COLUMNS.map((c) => (map[c] != null ? map[c] : ''));
}

/**
 * Tao 4 anh (fb, p1, p2, p3) -> up R2 -> tra link. Loi 1 anh KHONG lam sap ca bai.
 * @returns { fbImageUrl, thumbnailUrl, webUrls:{p1,p2,p3}, allOk, configured, errors[] }
 */
async function generateArticleImages(storyId, s, onProgress = () => {}, shouldStop = () => false) {
  const cfg = getImageConfig();
  const result = { fbImageUrl: '', thumbnailUrl: '', webUrls: { p1: '', p2: '', p3: '' }, allOk: false, configured: imageConfigReady(cfg), errors: [] };
  if (!result.configured) {
    onProgress({ message: 'ℹ️ Chưa cấu hình Ảnh & Lưu trữ — bỏ qua tạo ảnh (đẩy bài dạng chữ).' });
    return result;
  }
  const logger = (m) => onProgress({ message: m });
  // 5 anh/bai: fb (vuong) + thumb (ngang, RIENG) + 3 anh web (ngang).
  // Thumbnail dung khoi ===THUMB_PROMPT=== cua skill; neu bai cu chua co -> fallback web_p1_prompt.
  const jobs = [
    { kind: 'fb', prompt: s.FB_IMAGE_PROMPT },
    { kind: 'thumb', prompt: s.THUMB_PROMPT || s.WEB_P1_PROMPT, fallback: !s.THUMB_PROMPT },
    { kind: 'p1', prompt: s.WEB_P1_PROMPT },
    { kind: 'p2', prompt: s.WEB_P2_PROMPT },
    { kind: 'p3', prompt: s.WEB_P3_PROMPT },
  ];
  let okCount = 0;
  let madeAny = false; // da bat dau tao it nhat 1 anh chua -> de gian cach giua CAC LAN tao
  for (const j of jobs) {
    // DUNG giua chung khi dang tao anh: bo cac anh con lai -> bai se mang status need_image
    if (shouldStop()) { result.errors.push(`${j.kind}: đã dừng theo yêu cầu`); result.stopped = true; continue; }
    if (!j.prompt) { result.errors.push(`${j.kind}: thiếu prompt`); continue; }
    // TUAN TU: gian cach vai giay giua 2 lan tao anh (tranh gioi han tan suat Cloudflare)
    if (madeAny) { onProgress({ message: 'Đợi 5 giây trước khi tạo ảnh tiếp (tránh giới hạn Cloudflare)...' }); await delay(5000); }
    madeAny = true;
    if (j.kind === 'thumb' && j.fallback) onProgress({ message: 'ℹ️ Skill chưa xuất THUMB_PROMPT — dùng tạm web_p1_prompt cho thumbnail ngang.' });
    const r = await imageRouter.createAndUpload({ prompt: j.prompt, storyId, kind: j.kind, cfg }, logger);
    if (r.ok) {
      okCount++;
      if (j.kind === 'fb') result.fbImageUrl = r.url;
      else if (j.kind === 'thumb') result.thumbnailUrl = r.url;   // thumbnail NGANG rieng
      else result.webUrls[j.kind] = r.url;
    } else {
      result.errors.push(`${j.kind}: ${r.error}`);
    }
  }
  result.allOk = okCount === jobs.length;   // du 5 anh
  return result;
}

// Kiem tra bai co du cac phan quan trong khong (de thu lai neu Claude tra thieu khuon)
function isComplete(s) {
  return missingSections(s).length === 0;
}

// Dem so tu trong web_body (bo the HTML). Tieng Anh -> tach theo khoang trang.
function wordCount(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 0;
  return text.split(' ').filter(Boolean).length;
}
const MIN_WORDS = 2000;         // duoi nguong -> yeu cau viet dai them
const LENGTH_MAX_ATTEMPTS = 4;  // toi da vai lan ep dai

/**
 * Viet 1 bai. Mo 1 phien Claude, gui prompt goi skill, nhan ve, tach 16 cot.
 * Thu lai toi da 2 lan neu Claude tra sai khuon.
 */
async function writeOne(nicheLabel, nicheCode, onProgress = () => {}, shouldStop = () => false) {
  const engine = 'claude'; // skill manh nhat o Claude (dung theo y anh Thang)

  // STORY DNA: App gan to hop TRUOC (pool nuoc dang chay, da loc trung) + case conflict
  // TU DUNG CAY NGACH (theo nicheCode A/B/C/D/E) roi nhet vao dau prompt.
  const country = getRunningCountry();

  // ---- LOP DAU VAO (category/subcategory) chay TRUOC Story DNA ----
  const inSel = getInputSelection();
  const fastTest = !!inSel.fastTest;
  if (fastTest) onProgress({ message: '⚡ TEST NHANH — bỏ qua tạo ảnh, KHÔNG ghi sổ chống trùng (status = draft_test).' });
  let input = null;
  try {
    input = storyCategory.chooseInput({
      country,
      autoPage: inSel.mode === 'full_auto',
      pageId: inSel.pageId,
      categoryId: inSel.mode === 'category' ? inSel.categoryId : '',
      subcategoryId: inSel.mode === 'subcategory' ? inSel.subcategoryId : '',
    });
  } catch (e) {
    onProgress({ message: '⚠️ Lỗi lớp category: ' + e.message + ' — chạy theo ngách cũ.' });
    input = null;
  }

  // Cot D page_target: lay tu PAGE PROFILE (khong con lay tu o ngach A-E).
  // chooseInput loi -> chay theo ngach cu -> danh dau FALLBACK de nhan ra ngay.
  const pageTarget = (input && input.page_profile_id)
    ? `${input.page_profile_id} — ${input.page_name || ''}`.trim().replace(/\s+—\s*$/, '')
    : `FALLBACK — ${nicheLabel}`;
  if (!input) onProgress({ message: `⚠️ Chạy nhánh FALLBACK (ngách cũ) — page_target sẽ ghi "${pageTarget}".` });

  // ① Chu de gui Claude = category + subcategory (KHONG con ngach A-E) -> khong mau thuan
  //    voi khoi MANDATORY STORY INPUT.
  const topicLabel = (input && input.category_name)
    ? `${input.category_name} — ${input.subcategory_name || ''}`.trim().replace(/\s+—\s*$/, '')
    : nicheLabel;

  // ② Khoa so chong trung theo CATEGORY (khong con theo ngach A-E) -> cooldown
  //    icon+twist+ending / conflict duoc tinh RIENG cho tung category.
  //    Fallback (khong co input) van dung ten ngach cu de khong vo themeCodeOf.
  const dedupKey = (input && input.category_id) ? input.category_id : nicheLabel;

  const pick = storyDna.pickCombo(country, dedupKey, nicheCode, { input });
  if (input && input.category_id) {
    // CHI log category/subcategory/conflict CUOI CUNG (sau validate), khong log candidate bi loai
    onProgress({ message: `🗂️ ${input.page_profile_id} → ${input.category_name} (${input.category_id}) / ${input.subcategory_name} (${input.subcategory_id})${input.status_dynamic ? ' | status: ' + input.status_dynamic : ''}` });
    if (input.notes && input.notes.length) onProgress({ message: 'ℹ️ ' + input.notes.join('; ') });
  }
  if (pick.poolEmpty) {
    onProgress({ message: `ℹ️ Pool DNA của nước ${country} đang rỗng — chạy không có DNA (bài vẫn viết bình thường).` });
  } else {
    const conflictNote = pick.combo.conflict
      ? ` | conflict[${pick.conflictBranch}]: ${String(pick.combo.conflict).slice(0, 55)}...`
      : '';
    onProgress({ message: `🧬 DNA (${pick.theme || country}): ${pick.combo.hero_full_name} vs ${pick.combo.villain_full_name} | ${pick.combo.icon_object} | reveal: ${String(pick.combo.twist).slice(0, 40)}${conflictNote}` });
    if (pick.regen > 0) {
      onProgress({ message: `↻ DNA random lại ${pick.regen} lần cho tương thích + không trùng signature (weighted random).` });
    }
    if (pick.fellBack && !pick.valid) {
      onProgress({ message: `⚠️ Sau ${pick.tries} lần chưa có blueprint hoàn hảo (${pick.lastReason}) — dùng blueprint gần nhất.` });
    }
  }
  const dna = pick.poolEmpty ? null : { combo: pick.combo, country };
  // Cot 22: JSON gon, du truc ten ro rang (theme=ngach, conflict_id=case,...) + ma nuoc
  const dnaComboJson = dna ? storyDna.comboToSheetJson(pick.combo, country, nicheLabel) : '';
  if (dna && (!dnaComboJson || dnaComboJson.length < 20)) {
    onProgress({ message: '⚠️ Cảnh báo: có DNA nhưng cột story_dna rỗng — kiểm tra story-dna.js.' });
  }

  // Nhan hien thi theo PAGE·CATEGORY that (khong con nhan ngach A-E cu)
  const runLabel = (input && input.page_profile_id)
    ? `${input.page_profile_id} · ${input.category_name || input.category_id}`
    : `FALLBACK · ${nicheLabel}`;
  // VIEC 4: log ro khi pool reveal buoc phai noi (external tran vi pool lech)
  if (pick.combo && pick.combo.reveal_cap_note) {
    onProgress({ message: `⚠️ ${pick.combo.reveal_cap_note}` });
  }

  const basePrompt = buildPrompt(topicLabel, dna)
    + '\n\n[YÊU CẦU ĐỘ DÀI] web_body PHẢI dài 2200-2800 từ tiếng Anh (đếm từ). Viết đầy đủ 3 phần, thêm hồi tưởng, đối thoại, chi tiết cảm xúc. TUYỆT ĐỐI không viết ngắn dưới 2000 từ.';
  let prompt = basePrompt;
  let lastErr = null;

  const qaCfg = getQaConfig();
  // MOT cua so cho ca bai: moi attempt = doan chat MOI (sameChat=false); QA chay sameChat=true
  // ngay tren bai vua viet. Dong cua so o finally.
  const chat = await webai.openChat(engine, { show: false });
  try {
  for (let attempt = 1; attempt <= LENGTH_MAX_ATTEMPTS; attempt++) {
    onProgress({ message: `${runLabel}${attempt > 1 ? ` (thử lại lần ${attempt})` : ''}: Claude đang chạy skill viết truyện...` });
    const res = await chat.send(prompt, { timeoutMs: 420000 }); // doan chat MOI, skill dai -> cho 7 phut
    if (!res.ok) {
      lastErr = new Error(res.error || 'Claude không trả về');
      // Van ghi log de biet Claude tra ve gi (co the la thong bao loi cua trang)
      store.writeRawLog(res.text || '', {
        at: new Date().toISOString(), niche: nicheLabel, attempt,
        ok: false, missing: [], found: [], error: lastErr.message,
      });
      onProgress({ message: `✗ ${lastErr.message}` });
      continue;
    }

    const s = parseSections(res.text);
    const found = Object.keys(s);
    const missing = missingSections(s);
    const warnings = checkLeakedLabels(s);   // canh bao lot nhan (vd: web_p2_prompt con chua ===)
    const words = wordCount(s.WEB_BODY);     // so tu web_body (de ep do dai + log)

    // LUON ghi log tho -> co loi la mo man Log xem duoc ngay Claude tra ve gi
    store.writeRawLog(res.text, {
      at: new Date().toISOString(), niche: nicheLabel, attempt,
      ok: missing.length === 0, missing, found, warnings, words,
      rawLength: String(res.text || '').length,
      country,
      dnaCombo: dnaComboJson || null,                 // JSON that se ghi cot 22 (de verify)
      dnaComboParsed: dnaComboJson ? JSON.parse(dnaComboJson) : null,
      dnaConflictBranch: pick.conflictBranch || '',
      dnaTries: pick.tries, dnaFellBack: pick.fellBack,
      error: missing.length ? 'Thiếu khuôn' : '',
    });
    if (warnings.length) {
      onProgress({ message: '⚠️ CẢNH BÁO lọt nhãn: ' + warnings.join('; ') + ' — xem mục "Log".' });
    }

    if (isComplete(s)) {
      // EP DO DAI: dem tu web_body; qua ngan va con luot -> yeu cau viet dai them (giu DNA)
      onProgress({ message: `📏 web_body ~${words} từ.` });
      if (words < MIN_WORDS && attempt < LENGTH_MAX_ATTEMPTS) {
        store.writeRawLog(res.text, {
          at: new Date().toISOString(), niche: nicheLabel, attempt,
          ok: false, missing: [], found, words, error: `Quá ngắn (${words} < ${MIN_WORDS})`,
        });
        onProgress({ message: `↻ Bài chỉ ${words} từ (< ${MIN_WORDS}) — yêu cầu Claude viết dài thêm (2200-2800 từ) rồi làm lại.` });
        prompt = basePrompt
          + `\n\n[LẦN TRƯỚC QUÁ NGẮN: chỉ ${words} từ] Viết LẠI DÀI HƠN HẲN, 2200-2800 từ: thêm hồi tưởng quá khứ, đối thoại chi tiết, mô tả cảm xúc và bối cảnh. Đủ 3 phần, mỗi phần dày dặn.`;
        await delay(800);
        continue;
      }

      // ---- BUOC 2a: QA skill trong CUNG doan chat — CHI cho CTA + số liệu (TIEU DE do CODE lo) ----
      // Loi/timeout -> bo qua, chi canh bao. KHONG lam sap bai.
      let qaReport = '';
      if (qaCfg.enabled) {
        onProgress({ message: `🔎 Chạy QA (CTA/số liệu) (${qaCfg.command}) trong cùng đoạn chat...` });
        let qa = null;
        try {
          qa = await chat.send(qaCfg.command, { sameChat: true, timeoutMs: 180000 });
        } catch (e) {
          qa = { ok: false, error: e.message };
        }
        if (qa && qa.ok) {
          const q = parseSections(qa.text);
          qaReport = q.QA_REPORT || '';
          const changed = [];
          // TIEU DE gio kiem bang CODE (buoc 2b) — KHONG lay ===TITLE=== cua skill nua.
          if (q.CTA && q.CTA.trim()) { s.FB_CTA = q.CTA.trim(); changed.push('fb_cta'); }
          store.writeRawLog(qa.text, {
            at: new Date().toISOString(), niche: nicheLabel, attempt,
            ok: true, phase: 'title_qa', qaReport, overrode: changed,
          });
          onProgress({ message: changed.length
            ? `✏️ QA sửa ${changed.join(' + ')}${qaReport ? ' — ' + qaReport.slice(0, 160) : ''}`
            : `✓ QA (CTA/số liệu) xong${qaReport ? ' — ' + qaReport.slice(0, 160) : ''}` });
        } else {
          onProgress({ message: `⚠️ QA skill không chạy được (${(qa && qa.error) || 'không rõ'}) — bỏ qua CTA/số liệu.` });
          store.writeRawLog((qa && qa.text) || '', {
            at: new Date().toISOString(), niche: nicheLabel, attempt,
            ok: false, phase: 'title_qa', error: (qa && qa.error) || 'QA không trả về',
          });
        }
      }

      // ---- BUOC 2b: KIEM TIEU DE BANG CODE (luat co dinh) + yeu cau viet lai neu lo ket ----
      {
        let chk = checkTitle(s.WEB_TITLE || '');
        const origWords = chk.words, origLeak = chk.leak, origTitle = s.WEB_TITLE || '';
        let rewrites = 0;
        while (!chk.ok && rewrites < 3) {
          rewrites++;
          onProgress({ message: `📛 Tiêu đề lỗi (${chk.words} từ${chk.leak ? `, lộ kết: "${chk.leak}"` : ''}) — yêu cầu Claude viết lại (lần ${rewrites})...` });
          let rw = null;
          try { rw = await chat.send(titleRewritePrompt(chk.words, chk.leak), { sameChat: true, timeoutMs: 120000 }); }
          catch (e) { rw = { ok: false, error: e.message }; }
          if (!rw || !rw.ok) { onProgress({ message: `⚠️ Không nhận được tiêu đề mới (${(rw && rw.error) || '?'}).` }); break; }
          const nt = (parseSections(rw.text).TITLE || '').trim();
          if (!nt) { onProgress({ message: '⚠️ Claude không xuất ===TITLE===.' }); continue; }
          s.WEB_TITLE = nt;
          chk = checkTitle(s.WEB_TITLE);
        }
        if (!chk.ok) {
          s.WEB_TITLE = truncateTitle(s.WEB_TITLE || origTitle);
          chk = checkTitle(s.WEB_TITLE);
          onProgress({ message: `✂️ Tiêu đề vẫn lỗi sau ${rewrites} lần — tự cắt còn "${s.WEB_TITLE}" (${chk.words} từ${chk.leak ? `, còn cụm: "${chk.leak}"` : ''}).` });
        }
        store.writeRawLog('', {
          at: new Date().toISOString(), niche: nicheLabel, attempt, phase: 'title_check',
          origWords, origLeak, origTitle, finalTitle: s.WEB_TITLE, finalWords: titleWordCount(s.WEB_TITLE), rewrites, passed: chk.ok,
        });
        onProgress({ message: `🏷️ Tiêu đề: ${origWords}→${titleWordCount(s.WEB_TITLE)} từ, viết lại ${rewrites} lần${origLeak ? `, lỗi gốc: "${origLeak}"` : ', không lỗi gốc'}.` });
      }

      // ---- BUOC 2c: KIEM COLD OPEN (dau web_body, 5 doan) BANG CODE ----
      {
        let co = checkColdOpen(s.WEB_BODY || '');
        const origFirst = co.first, origThree = co.three, origReason = co.reason || '';
        let rewrites = 0;
        while (!co.ok && rewrites < 2) {
          rewrites++;
          onProgress({ message: `🥶 Cold open lỗi (${co.reason}) — yêu cầu Claude viết lại phần mở đầu 5 dòng (lần ${rewrites})...` });
          let rw = null;
          try { rw = await chat.send(coldOpenRewritePrompt(co), { sameChat: true, timeoutMs: 120000 }); }
          catch (e) { rw = { ok: false, error: e.message }; }
          if (!rw || !rw.ok) { onProgress({ message: `⚠️ Không nhận được cold open mới (${(rw && rw.error) || '?'}).` }); break; }
          const block = (parseSections(rw.text).COLD_OPEN || '').trim();
          if (!/<p\b/i.test(block)) { onProgress({ message: '⚠️ Claude không xuất ===COLD_OPEN=== có <p>.' }); continue; }
          s.WEB_BODY = insertColdOpen(s.WEB_BODY || '', block);
          co = checkColdOpen(s.WEB_BODY);
        }
        if (!co.ok) {
          // KHONG tu chen gi -> giu nguyen bai goc, chi canh bao.
          onProgress({ message: `⚠️ Cold open vẫn lỗi sau ${rewrites} lần — giữ nguyên bài gốc (${co.reason}).` });
        }
        store.writeRawLog('', {
          at: new Date().toISOString(), niche: nicheLabel, attempt, phase: 'cold_open_check',
          origFirst, origThree, origReason, finalFirst: co.first, finalThree: co.three, finalP4: co.p4, finalP5: co.p5, rewrites, passed: co.ok,
        });
        onProgress({ message: `🧊 Cold open: đoạn đầu ${origFirst}→${co.first} từ, đoạn 4/5 ${co.p4}/${co.p5} từ, viết lại ${rewrites} lần.` });
      }

      // ---- BUOC 2d: KIEM CTA BANG CODE (khong doi comment/type YES, khong lo noi dung sau) ----
      {
        let cc = checkCta(s.FB_CTA || '');
        const origReason = cc.reason, origCta = s.FB_CTA || '';
        let rewrites = 0;
        while (!cc.ok && rewrites < 2) {
          rewrites++;
          onProgress({ message: `📣 CTA lỗi (${cc.reason}) — yêu cầu Claude viết lại (lần ${rewrites})...` });
          let rw = null;
          try { rw = await chat.send(ctaRewritePrompt(cc.reason), { sameChat: true, timeoutMs: 90000 }); }
          catch (e) { rw = { ok: false, error: e.message }; }
          if (!rw || !rw.ok) { onProgress({ message: `⚠️ Không nhận được CTA mới (${(rw && rw.error) || '?'}).` }); break; }
          const nc = (parseSections(rw.text).CTA || '').trim();
          if (!nc) { onProgress({ message: '⚠️ Claude không xuất ===CTA===.' }); continue; }
          s.FB_CTA = nc;
          cc = checkCta(s.FB_CTA);
        }
        if (!cc.ok) {
          s.FB_CTA = CTA_SAFE_DEFAULT;             // het luot -> cau mac dinh an toan
          cc = checkCta(s.FB_CTA);
          onProgress({ message: `🔁 CTA vẫn lỗi sau ${rewrites} lần — thay bằng câu mặc định: "${CTA_SAFE_DEFAULT}"` });
        }
        store.writeRawLog('', {
          at: new Date().toISOString(), niche: nicheLabel, attempt, phase: 'cta_check',
          origReason, origCta, finalCta: s.FB_CTA, rewrites, passed: cc.ok,
        });
        onProgress({ message: `📢 CTA: viết lại ${rewrites} lần${origReason ? `, lỗi gốc: ${origReason}` : ', không lỗi gốc'}.` });
      }

      // ---- HOOK_VARIANTS (tuy chon): parse neu co -> ghi log. Khong co cung khong loi. ----
      if (s.HOOK_VARIANTS) {
        let parsed = null;
        try { parsed = JSON.parse(s.HOOK_VARIANTS); } catch (_) {
          const m = String(s.HOOK_VARIANTS).match(/[[{][\s\S]*[\]}]/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
        }
        store.writeRawLog(s.HOOK_VARIANTS, {
          at: new Date().toISOString(), niche: nicheLabel, attempt, phase: 'hook_variants',
          got: true, valid: !!parsed, count: Array.isArray(parsed) ? parsed.length : (parsed ? 1 : 0),
        });
        onProgress({ message: `🪝 Nhận HOOK_VARIANTS${parsed ? ` (${Array.isArray(parsed) ? parsed.length : 1} phương án, đã ghi Log)` : ' (không parse được JSON, đã ghi thô)'}.` });
      } else {
        onProgress({ message: 'ℹ️ Không có HOOK_VARIANTS (bỏ qua, không lỗi).' });
      }

      // Cap story_id (bo dem local, +1 moi bai)
      const storyId = store.nextStoryId();

      // ---- TEST NHANH: bo qua toan bo tao anh + upload R2 ----
      let imgs, status;
      if (fastTest) {
        onProgress({ message: `✓ Claude xong bài ${storyId} (~${words} từ). ⚡ Test nhanh — KHÔNG tạo ảnh.` });
        imgs = { fbImageUrl: '', thumbnailUrl: '', webUrls: { p1: '', p2: '', p3: '' }, allOk: true, configured: false, errors: [] };
        status = 'draft_test';                 // n8n KHONG duoc dang bai test
      } else {
        onProgress({ message: `✓ Claude xong bài ${storyId} (~${words} từ) — ${runLabel}. Đang tạo ảnh...` });
        // Tao 5 anh (fb, thumb, p1, p2, p3) -> up R2. Loi anh KHONG lam sap bai.
        try {
          imgs = await generateArticleImages(storyId, s, onProgress, shouldStop);
        } catch (e) {
          imgs = { fbImageUrl: '', thumbnailUrl: '', webUrls: { p1: '', p2: '', p3: '' }, allOk: false, configured: true, errors: [e.message] };
          onProgress({ message: '⚠️ Lỗi tạo ảnh: ' + e.message + ' — vẫn đẩy bài (link ảnh để trống).' });
        }
        status = (imgs.configured && !imgs.allOk) ? 'need_image' : 'new';
        if (status === 'need_image') {
          onProgress({ message: `⚠️ Bài ${storyId}: tạo ảnh chưa đủ (${imgs.errors.join('; ')}). Đẩy bài, đánh dấu need_image để chạy lại.` });
        } else {
          onProgress({ message: `✓ Xong bài ${storyId} — ${runLabel}` });
        }
      }

      // Thay {{IMG_Px}} trong web_body bang link that (thieu link thi go the img)
      const webBody = applyImagePlaceholders(s.WEB_BODY || '', imgs.webUrls);

      const row = buildRow(nicheLabel, s, {
        storyId, status, webBody, pageTarget,
        fbImageUrl: imgs.fbImageUrl,
        thumbnailUrl: imgs.thumbnailUrl,
        dnaCombo: dnaComboJson,
      });

      // GHI SO chong trung: chi ghi khi da chot bai thanh cong (tranh dot bo dem oan).
      // TEST NHANH -> KHONG ghi, de khong lam ban cooldown cua bai that
      // (ten/icon/conflict/subcategory khong bi danh dau la "da dung").
      if (dna && !fastTest) {
        try { storyDna.remember({ storyId, country, niche: dedupKey, combo: pick.combo }); }
        catch (_) { /* ghi so hong khong lam sap bai */ }
      } else if (fastTest && dna) {
        // TEST NHANH: ghi vao SO TAM (chi song trong phien) -> cac bai cung lan chay van
        // thay nhau de xoay page + tranh lap subcategory/icon/reveal_family/justice_family.
        // So dai han tren dia KHONG bi dong den.
        try { memory.addSession({ storyId, country, niche: dedupKey, combo: pick.combo }); }
        catch (_) {}
        onProgress({ message: `ℹ️ Test nhanh: ghi sổ TẠM trong phiên (${memory.sessionCount()} bài) — sổ chống trùng dài hạn giữ nguyên.` });
      }

      return { ok: true, row, raw: res.text, sections: s, storyId, status, dnaCombo: dnaComboJson, qaReport };
    }
    // BAO RO thieu mang nao + tim thay mang nao + do dai ket qua tho
    const rawLen = String(res.text || '').length;
    lastErr = new Error(
      'Claude trả về THIẾU KHUÔN. Thiếu: ' + missing.join('; ') + '. '
      + 'Các mảnh tìm thấy: ' + (found.length ? found.join(', ') : 'KHÔNG có mảnh nào')
      + `. (Claude trả về ${rawLen} ký tự — mở mục "Log" để xem nguyên văn.)`
    );
    onProgress({ message: '✗ ' + lastErr.message });
    onProgress({ message: 'ℹ️ Đã lưu nguyên văn kết quả Claude vào mục "Log" (bên trái) để chẩn đoán.' });
    await delay(1000);
  }
  return { ok: false, error: lastErr ? lastErr.message : 'không rõ' };
  } finally {
    try { chat.close(); } catch (_) {}     // luon dong cua so Claude, ke ca khi loi
  }
}

/**
 * Viet NHIEU bai lien tiep (moi bai 1 phien rieng -> khong don ngu canh -> chong lap tot hon).
 * @param {{niche:string, count:number}} input
 */
async function writeBatch({ niche, count, pushRow = null, shouldStop = () => false }, onProgress = () => {}) {
  const niches = getNiches();
  const found = niches.find((n) => n.code === niche || n.label === niche);
  const nicheLabel = found ? found.label : (niche || niches[0].label);
  const nicheCode = found ? found.code : String(niche || '').toUpperCase();
  const total = Math.max(1, Math.min(50, parseInt(count, 10) || 1)); // tran an toan 50 bai/lan

  // KHONG sessionStart() o day nua. So tam cua TEST NHANH phai GIU qua cac lan bam "Bat dau viet"
  // trong CUNG mot lan mo app -> page moi xoay dung (1 bai x5 lan = 5 page). Xoa khi tat app
  // (SESSION reset khi nap lai module) hoac khi bam nut "Reset sổ tạm".
  const rows = [];
  const failed = [];
  const pushFailed = [];
  let stopped = false;
  for (let i = 0; i < total; i++) {
    // DUNG: chi kiem tra GIUA cac bai -> bai dang viet do luon duoc chay het
    if (shouldStop()) {
      stopped = true;
      onProgress({ message: `⏹ Đã dừng theo yêu cầu — còn ${total - i} bài chưa chạy.` });
      break;
    }
    onProgress({ message: `Bài ${i + 1}/${total} — đang chọn page & viết...`, done: i, total });
    const r = await writeOne(nicheLabel, nicheCode, onProgress, shouldStop);
    if (!r.ok) { failed.push({ index: i + 1, error: r.error }); continue; }
    rows.push(r.row);
    // DAY SHEET NGAY tung bai: crash giua chung chi mat bai dang do, khong mat ca loat.
    // Bai nao day loi thi log ro va CHAY TIEP bai sau.
    if (pushRow) {
      try {
        await pushRow(r.row, r);
        onProgress({ message: `⬆️ Đã đẩy bài ${r.storyId} lên Google Sheet.` });
      } catch (e) {
        pushFailed.push({ index: i + 1, storyId: r.storyId, error: e.message });
        onProgress({ message: `⚠️ Bài ${r.storyId} viết xong nhưng ĐẨY SHEET LỖI: ${e.message} — chạy tiếp bài sau.` });
      }
    }
  }
  if (stopped && shouldStop()) onProgress({ message: `⏹ Dừng: đã xong ${rows.length} bài.` });
  // KHONG xoa so tam o day (giu qua cac lan chay) -> chi xoa khi tat app / bam Reset.
  return { ok: rows.length > 0, rows, failed, pushFailed, stopped, columns: SHEET_COLUMNS };
}

function getNiches() {
  const settings = store.read('settings.json');
  const custom = settings.story && Array.isArray(settings.story.niches) && settings.story.niches.length
    ? settings.story.niches : null;
  return custom || DEFAULT_NICHES;
}

module.exports = {
  writeBatch,
  writeOne,
  getNiches,
  SHEET_COLUMNS,
  DEFAULT_SKILL_COMMAND,
  DEFAULT_NICHES,
  // exported for tests / reuse
  titleWordCount, findTitleLeak, checkTitle, truncateTitle, titleRewritePrompt,
  firstParagraphs, checkColdOpen, insertColdOpen, coldOpenRewritePrompt,
  checkCta, ctaRewritePrompt, CTA_SAFE_DEFAULT,
  parseSections,
  missingSections,
  checkLeakedLabels,
  cleanBlock,
  isComplete,
  generateArticleImages,
  normalizeJson,
  normalizeKpi,
  wordCount,
  MIN_WORDS,
  applyImagePlaceholders,
  buildRow,
  DEDUP_TEMPLATE,
  REVEAL_TEMPLATE,
  KPI_TEMPLATE,
};
