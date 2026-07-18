'use strict';

/**
 * BO NAO viet truyen "Justice Fantasy" cho phu nu My 55-75, thay cho translator.js cu.
 *
 *  - KHONG dich. KHONG can link. Skill tu sinh chu de.
 *  - Dieu khien Claude WEB (login, khong API) qua webai-electron.js.
 *  - Goi skill "story-us-senior-viral" da Save trong tai khoan Claude (Cach 1 - gon).
 *  - Nhan ket qua theo khuon ===COT=== (khong JSON - ngoac kep lam vo JSON, giong ban dich cu).
 *  - Tach thanh 16 cot dung thu tu Google Sheet -> n8n cao dung.
 *
 * Ket qua 1 bai: { row: [16 o], raw: '<van ban Claude tra ve>' }
 */

const store = require('./store');
const webai = require('./webai-electron');

// ---- Cac NGACH mac dinh (page target). Nguoi dung sua duoc trong Cai dat. ----
const DEFAULT_NICHES = [
  { code: 'A', label: 'Mẹ già – con bạc bẽo' },
  { code: 'B', label: 'Cựu chiến binh bị coi thường' },
  { code: 'C', label: 'Cô dâu mới – nhà chồng chà đạp' },
  { code: 'D', label: 'Vợ bị phản bội – nắm bằng chứng' },
  { code: 'E', label: 'Người nghèo tử tế vs họ hàng giàu' },
];

// Cac COT xuat ra Google Sheet - PHAI khop HEADER trong Apps Script (docs/GOOGLE-SHEETS-SETUP.md)
const SHEET_COLUMNS = [
  'timestamp', 'status', 'page_target', 'web_title', 'web_slug', 'web_body',
  'web_image_prompt', 'fb_caption_a', 'fb_caption_b', 'fb_cta',
  'fb_image_prompt', 'fb_comment_link', 'web_url', 'dedup_config',
  'reveal_type', 'kpi_scores',
];

// Cau lenh goi skill - MAC DINH (Cach 1). Nguoi dung sua duoc trong Cai dat (tuy bien).
// {NICHE} se duoc thay bang ten ngach. Skill tu chay pipeline 11 buoc.
const DEFAULT_SKILL_COMMAND =
  `/story-us-senior-viral viết truyện Mỹ 55+ cho ngách "{NICHE}".

Chạy đầy đủ pipeline tự động (tự sinh idea, 20 hook, chấm KPI, đóng vai độc giả 55-75 chọn hook, viết caption A/B, viết bài web Part 1/2/3, 7 reviewer, adaptive threshold). Chống lặp với các bài đã sinh.

QUAN TRỌNG — xuất kết quả theo ĐÚNG khuôn nhãn dưới đây để phần mềm bóc tách (KHÔNG JSON, KHÔNG lời dẫn thừa, mỗi nhãn 1 dòng riêng):

===WEB_TITLE===
<tiêu đề web SEO, dài, nhồi twist, tiếng Anh>
===WEB_SLUG===
<đường dẫn url chữ thường gạch ngang, tiếng Anh>
===WEB_BODY===
<toàn bộ bài web Part 1/2/3, tiếng Anh Mỹ>
===WEB_IMAGE_PROMPT===
<mô tả ảnh minh họa trong bài, tiếng Anh, tả cảnh cao trào>
===FB_CAPTION_A===
<caption Facebook bản A dài ~600-900 từ, cắt cliffhanger>
===FB_CAPTION_B===
<caption Facebook bản B ngắn ~300-400 từ, đấm nhanh>
===FB_CTA===
<câu CTA kiểu "Type YES...", KHÔNG kèm link>
===FB_IMAGE_PROMPT===
<mô tả ảnh mồi Facebook, tiếng Anh, kịch tính, tỉ lệ vuông>
===DEDUP_CONFIG===
<nạn nhân | kẻ ác | đòn công lý | icon object — để chống lặp>
===REVEAL_TYPE===
<kiểu lật mở đã dùng, ví dụ: military history / old letter / DNA...>
===KPI_SCORES===
<bảng điểm KPI ngắn gọn: hook, CTR, justice, novelty, trung bình reviewer>
===END===`;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Doc output theo khuon ===KEY=== (giong parseSections cua ban dich cu - ben vung voi ngoac/xuong dong)
function parseSections(text) {
  const map = {};
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*===\s*([A-Z0-9_]+)\s*===\s*$/i);
    if (m) { cur = m[1].toUpperCase(); if (cur !== 'END') map[cur] = []; continue; }
    if (raw.trim().startsWith('```')) continue; // bo dong fence
    if (cur && cur !== 'END') map[cur].push(raw);
  }
  const out = {};
  for (const k of Object.keys(map)) out[k] = map[k].join('\n').trim();
  return out;
}

// Lay cau lenh skill (co the da tuy bien trong Cai dat), thay {NICHE}
function buildPrompt(nicheLabel) {
  const settings = store.read('settings.json');
  const tmpl = (settings.story && settings.story.skillCommand) || DEFAULT_SKILL_COMMAND;
  return tmpl.replace(/\{NICHE\}/g, nicheLabel);
}

// Ghep 1 bai thanh 16 o dung thu tu SHEET_COLUMNS
function buildRow(nicheLabel, s) {
  const now = new Date().toLocaleString('vi-VN');
  const map = {
    timestamp: now,
    status: 'new',                                  // n8n nhin cot nay biet bai chua dang
    page_target: nicheLabel,
    web_title: s.WEB_TITLE || '',
    web_slug: s.WEB_SLUG || '',
    web_body: s.WEB_BODY || '',
    web_image_prompt: s.WEB_IMAGE_PROMPT || '',
    fb_caption_a: s.FB_CAPTION_A || '',
    fb_caption_b: s.FB_CAPTION_B || '',
    fb_cta: s.FB_CTA || '',
    fb_image_prompt: s.FB_IMAGE_PROMPT || '',
    fb_comment_link: '[LINK]',                       // n8n dien link web sau khi dang
    web_url: '',                                     // n8n dien sau khi dang WordPress
    dedup_config: s.DEDUP_CONFIG || '',
    reveal_type: s.REVEAL_TYPE || '',
    kpi_scores: s.KPI_SCORES || '',
  };
  return SHEET_COLUMNS.map((c) => map[c] || '');
}

// Kiem tra bai co du cac phan quan trong khong (de thu lai neu Claude tra thieu khuon)
function isComplete(s) {
  return !!(s.WEB_BODY && s.WEB_BODY.length > 300 &&
            s.FB_CAPTION_A && s.FB_CAPTION_B && s.WEB_TITLE);
}

/**
 * Viet 1 bai. Mo 1 phien Claude, gui prompt goi skill, nhan ve, tach 16 cot.
 * Thu lai toi da 2 lan neu Claude tra sai khuon.
 */
async function writeOne(nicheLabel, onProgress = () => {}) {
  const engine = 'claude'; // skill manh nhat o Claude (dung theo y anh Thang)
  const prompt = buildPrompt(nicheLabel);
  let lastErr = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    onProgress({ message: `Ngách "${nicheLabel}"${attempt > 1 ? ` (thử lại lần ${attempt})` : ''}: Claude đang chạy skill viết truyện...` });
    const res = await webai.ask(engine, { prompt, show: false, timeoutMs: 420000 }); // skill dai -> cho 7 phut
    if (!res.ok) { lastErr = new Error(res.error || 'Claude không trả về'); continue; }

    const s = parseSections(res.text);
    if (isComplete(s)) {
      onProgress({ message: `✓ Xong bài ngách "${nicheLabel}"` });
      return { ok: true, row: buildRow(nicheLabel, s), raw: res.text, sections: s };
    }
    lastErr = new Error('Claude trả về thiếu khuôn (thiếu WEB_BODY / caption / title).');
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
  const total = Math.max(1, Math.min(50, parseInt(count, 10) || 1)); // tran an toan 50 bai/lan

  const rows = [];
  const failed = [];
  for (let i = 0; i < total; i++) {
    onProgress({ message: `Bài ${i + 1}/${total} — ngách "${nicheLabel}"...`, done: i, total });
    const r = await writeOne(nicheLabel, onProgress);
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
};
