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
const storyDna = require('./story-dna');

// ---- Cac NGACH mac dinh (page target). Nguoi dung sua duoc trong Cai dat. ----
const DEFAULT_NICHES = [
  { code: 'A', label: 'Mẹ già – con bạc bẽo' },
  { code: 'B', label: 'Cựu chiến binh bị coi thường' },
  { code: 'C', label: 'Cô dâu mới – nhà chồng chà đạp' },
  { code: 'D', label: 'Vợ bị phản bội – nắm bằng chứng' },
  { code: 'E', label: 'Người nghèo tử tế vs họ hàng giàu' },
];

// Cac COT xuat ra Google Sheet (22 cot) - PHAI khop HEADER trong Apps Script (docs/GOOGLE-SHEETS-SETUP.md)
// Cot 22 story_dna_combo = to hop DNA App gan san (JSON, kem ma quoc gia).
const SHEET_COLUMNS = [
  'story_id', 'timestamp', 'status', 'page_target', 'web_title', 'web_slug', 'web_body',
  'fb_caption_a', 'fb_caption_b', 'fb_cta', 'fb_comment_link', 'web_url',
  'fb_image_url', 'thumbnail_url', 'fb_image_prompt', 'web_p1_prompt', 'web_p2_prompt', 'web_p3_prompt',
  'dedup_config', 'story_dna', 'kpi_scores', 'story_dna_combo',
];

// ---- Khuon JSON mac dinh cho 3 cot JSON (dam bao du khoa ke ca khi Claude tra thieu) ----
const DEDUP_TEMPLATE = { victim: '', villain: '', theme: '', emotion: '', justice: '', object: '', setting: '', ending: '' };
const STORY_DNA_TEMPLATE = { reveal: '', reveal_source: '', object: '', justice: '' };
const KPI_TEMPLATE = { hook: 0, facebook_ctr: 0, justice: 0, empathy: 0, novelty: 0, american: 0, final: 0 };

// Cau lenh goi skill - MAC DINH (Cach 1). Nguoi dung sua duoc trong Cai dat (tuy bien).
// {NICHE} se duoc thay bang ten ngach. Skill tu chay pipeline 11 buoc.
const DEFAULT_SKILL_COMMAND =
  `/story-us-senior-viral viết truyện Mỹ 55+ cho ngách "{NICHE}".

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
  return {
    cfAccountId: dec(img.cfAccountId),
    cfApiToken: dec(img.cfApiToken),
    r2AccessKeyId: dec(img.r2AccessKeyId),
    r2SecretAccessKey: dec(img.r2SecretAccessKey),
    r2Endpoint: (img.r2Endpoint || '').trim(),
    r2Bucket: (img.r2Bucket || '').trim(),
    r2PublicDomain: (img.r2PublicDomain || '').trim(),
  };
}

function imageConfigReady(cfg) {
  return !!(cfg.cfAccountId && cfg.cfApiToken && cfg.r2Endpoint && cfg.r2AccessKeyId
            && cfg.r2SecretAccessKey && cfg.r2Bucket && cfg.r2PublicDomain);
}

// Nuoc dang chay (mac dinh US). Nguoi dung chon trong Cai dat -> Story DNA.
function getRunningCountry() {
  try {
    const s = store.read('settings.json');
    const c = s.dna && s.dna.runningCountry;
    return (c ? String(c) : storyDna.DEFAULT_COUNTRY).toUpperCase();
  } catch (_) { return storyDna.DEFAULT_COUNTRY; }
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

// Dung prompt cuoi = KHOI DNA (bat buoc dung to hop) + cau lenh goi skill.
// @param dna { combo, country } da chon san (co the null -> khong nhet DNA)
function buildPrompt(nicheLabel, dna) {
  const country = (dna && dna.country) || getRunningCountry();
  const tmpl = getSkillTemplate(country).replace(/\{NICHE\}/g, nicheLabel);
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
    page_target: nicheLabel,
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
    dedup_config: normalizeJson(s.DEDUP_CONFIG, DEDUP_TEMPLATE),
    story_dna: normalizeJson(s.STORY_DNA, STORY_DNA_TEMPLATE),
    kpi_scores: normalizeJson(s.KPI_SCORES, KPI_TEMPLATE, true),
    // Cot 22: to hop DNA App gan san (JSON, kem ma quoc gia)
    story_dna_combo: extra.dnaCombo != null ? extra.dnaCombo : '',
  };
  return SHEET_COLUMNS.map((c) => (map[c] != null ? map[c] : ''));
}

/**
 * Tao 4 anh (fb, p1, p2, p3) -> up R2 -> tra link. Loi 1 anh KHONG lam sap ca bai.
 * @returns { fbImageUrl, thumbnailUrl, webUrls:{p1,p2,p3}, allOk, configured, errors[] }
 */
async function generateArticleImages(storyId, s, onProgress = () => {}) {
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
    if (!j.prompt) { result.errors.push(`${j.kind}: thiếu prompt`); continue; }
    // TUAN TU: gian cach vai giay giua 2 lan tao anh (tranh gioi han tan suat Cloudflare)
    if (madeAny) { onProgress({ message: 'Đợi 5 giây trước khi tạo ảnh tiếp (tránh giới hạn Cloudflare)...' }); await delay(5000); }
    madeAny = true;
    if (j.kind === 'thumb' && j.fallback) onProgress({ message: 'ℹ️ Skill chưa xuất THUMB_PROMPT — dùng tạm web_p1_prompt cho thumbnail ngang.' });
    const r = await imageGen.createAndUpload({ prompt: j.prompt, storyId, kind: j.kind, cfg }, logger);
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

/**
 * Viet 1 bai. Mo 1 phien Claude, gui prompt goi skill, nhan ve, tach 16 cot.
 * Thu lai toi da 2 lan neu Claude tra sai khuon.
 */
async function writeOne(nicheLabel, nicheCode, onProgress = () => {}) {
  const engine = 'claude'; // skill manh nhat o Claude (dung theo y anh Thang)

  // STORY DNA: App gan to hop TRUOC (pool nuoc dang chay, da loc trung) + case conflict
  // TU DUNG CAY NGACH (theo nicheCode A/B/C/D/E) roi nhet vao dau prompt.
  const country = getRunningCountry();
  const pick = storyDna.pickCombo(country, nicheLabel, nicheCode);
  if (pick.poolEmpty) {
    onProgress({ message: `ℹ️ Pool DNA của nước ${country} đang rỗng — chạy không có DNA (bài vẫn viết bình thường).` });
  } else {
    const conflictNote = pick.combo.conflict
      ? ` | conflict[${pick.conflictBranch}]: ${String(pick.combo.conflict).slice(0, 60)}...`
      : ' | (ngách chưa có cây conflict — dùng humiliation_type)';
    onProgress({ message: `🧬 DNA (${country}): ${pick.combo.hero_name} — ${pick.combo.icon_object}${conflictNote}` });
  }
  const dna = pick.poolEmpty ? null : { combo: pick.combo, country };
  const dnaComboJson = dna ? JSON.stringify(Object.assign({ country }, pick.combo)) : '';

  const prompt = buildPrompt(nicheLabel, dna);
  let lastErr = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    onProgress({ message: `Ngách "${nicheLabel}"${attempt > 1 ? ` (thử lại lần ${attempt})` : ''}: Claude đang chạy skill viết truyện...` });
    const res = await webai.ask(engine, { prompt, show: false, timeoutMs: 420000 }); // skill dai -> cho 7 phut
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

    // LUON ghi log tho -> co loi la mo man Log xem duoc ngay Claude tra ve gi
    store.writeRawLog(res.text, {
      at: new Date().toISOString(), niche: nicheLabel, attempt,
      ok: missing.length === 0, missing, found, warnings,
      rawLength: String(res.text || '').length,
      country, dnaCombo: dna ? Object.assign({ country }, pick.combo) : null,
      dnaTries: pick.tries, dnaFellBack: pick.fellBack,
      error: missing.length ? 'Thiếu khuôn' : '',
    });
    if (warnings.length) {
      onProgress({ message: '⚠️ CẢNH BÁO lọt nhãn: ' + warnings.join('; ') + ' — xem mục "Log".' });
    }

    if (isComplete(s)) {
      // Cap story_id (bo dem local, +1 moi bai)
      const storyId = store.nextStoryId();
      onProgress({ message: `✓ Claude xong bài ${storyId} — ngách "${nicheLabel}". Đang tạo ảnh...` });

      // Tao 4 anh (fb, p1, p2, p3) -> up R2. Loi anh KHONG lam sap bai.
      let imgs;
      try {
        imgs = await generateArticleImages(storyId, s, onProgress);
      } catch (e) {
        imgs = { fbImageUrl: '', thumbnailUrl: '', webUrls: { p1: '', p2: '', p3: '' }, allOk: false, configured: true, errors: [e.message] };
        onProgress({ message: '⚠️ Lỗi tạo ảnh: ' + e.message + ' — vẫn đẩy bài (link ảnh để trống).' });
      }

      // Thay {{IMG_Px}} trong web_body bang link that (thieu link thi go the img)
      const webBody = applyImagePlaceholders(s.WEB_BODY || '', imgs.webUrls);

      // Trang thai: neu co cau hinh anh nhung chua tao du -> 'need_image' de chay lai sau
      const status = (imgs.configured && !imgs.allOk) ? 'need_image' : 'new';
      if (status === 'need_image') {
        onProgress({ message: `⚠️ Bài ${storyId}: tạo ảnh chưa đủ (${imgs.errors.join('; ')}). Đẩy bài, đánh dấu need_image để chạy lại.` });
      } else {
        onProgress({ message: `✓ Xong bài ${storyId} — ngách "${nicheLabel}"` });
      }

      const row = buildRow(nicheLabel, s, {
        storyId, status, webBody,
        fbImageUrl: imgs.fbImageUrl,
        thumbnailUrl: imgs.thumbnailUrl,
        dnaCombo: dnaComboJson,
      });

      // GHI SO chong trung: chi ghi khi da chot bai thanh cong (tranh dot bo dem oan)
      if (dna) {
        try { storyDna.remember({ storyId, country, niche: nicheLabel, combo: pick.combo }); }
        catch (_) { /* ghi so hong khong lam sap bai */ }
      }

      return { ok: true, row, raw: res.text, sections: s, storyId, status, dnaCombo: dnaComboJson };
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
}

/**
 * Viet NHIEU bai lien tiep (moi bai 1 phien rieng -> khong don ngu canh -> chong lap tot hon).
 * @param {{niche:string, count:number}} input
 */
async function writeBatch({ niche, count }, onProgress = () => {}) {
  const niches = getNiches();
  const found = niches.find((n) => n.code === niche || n.label === niche);
  const nicheLabel = found ? found.label : (niche || niches[0].label);
  const nicheCode = found ? found.code : String(niche || '').toUpperCase();
  const total = Math.max(1, Math.min(50, parseInt(count, 10) || 1)); // tran an toan 50 bai/lan

  const rows = [];
  const failed = [];
  for (let i = 0; i < total; i++) {
    onProgress({ message: `Bài ${i + 1}/${total} — ngách "${nicheLabel}"...`, done: i, total });
    const r = await writeOne(nicheLabel, nicheCode, onProgress);
    if (r.ok) rows.push(r.row);
    else failed.push({ index: i + 1, error: r.error });
  }
  return { ok: rows.length > 0, rows, failed, columns: SHEET_COLUMNS };
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
  parseSections,
  missingSections,
  checkLeakedLabels,
  cleanBlock,
  isComplete,
  generateArticleImages,
  normalizeJson,
  applyImagePlaceholders,
  buildRow,
  DEDUP_TEMPLATE,
  STORY_DNA_TEMPLATE,
  KPI_TEMPLATE,
};
