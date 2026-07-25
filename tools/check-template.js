'use strict';
/**
 * GUARD TEMPLATE — chay TRUOC moi lan build (npm run build:win).
 *
 * VI SAO CO FILE NAY: 2 lan trong cung mot ngay, TEMPLATE cua app day Claude lam dung
 * cai ma chinh app dang cam, roi 5 lop kiem code phai chua chay tung bai:
 *   - "cinematic" o WEB_P1/P2/P3  -> ChatGPT tu choi ve anh
 *   - 'CTA kieu "Type YES..."'    -> loi CTA o luot dau MOI bai
 * Nguoi dung di sua skill tren claude.ai, nhung thu dang dieu khien lai la template nay.
 *
 * NGUYEN TAC: doc THANG cac mang cam tu story-writer.js (KHONG chep lai — chep la se troi lech).
 * Template chua chuoi ma app dang cam -> FAIL BUILD, neu dich danh dong + chuoi.
 *
 * XU LY PHU DINH: template duoc phep DAY "KHONG dung Type YES" — chi bat khi template
 * DAY DUNG chuoi do. Giong cach findBannedImageTerm bo qua "not cinematic".
 */
const path = require('path');
const sw = require(path.join(__dirname, '..', 'src', 'main', 'story-writer.js'));

// Dau hieu NGU CANH CAM (Viet + Anh). Co bat ky dau hieu nao truoc chuoi -> la loi dan cam, hop le.
const NEGATION = /⛔|KHÔNG|KHONG|TUYỆT ĐỐI|TUYET DOI|CẤM|CAM\b|tránh|\bnot\b|\bno\b|\bnever\b|\bavoid\b|\bwithout\b|\bdon't\b|\bdo not\b/i;

function scanPhrases(label, text, phrases, sourceName, out) {
  const lines = String(text || '').split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const low = line.toLowerCase();
    for (const p of phrases) {
      const term = String(p).toLowerCase();
      let i = -1;
      while ((i = low.indexOf(term, i + 1)) !== -1) {
        const prefix = line.slice(0, i);                 // phan dau dong truoc chuoi
        if (NEGATION.test(prefix)) continue;             // dang CAM -> hop le
        out.push({ source: sourceName, layer: label, term: p, line: li + 1, text: line.trim().slice(0, 110) });
      }
    }
  }
}

// Luat tieu de: dung DUNG bo do cua app (findTitleLeak) thay vi ghep tho danh sach danh tu,
// vi luat that la "a|an|the + danh tu", khong phai danh tu tran.
function scanTitleRules(text, sourceName, out) {
  const lines = String(text || '').split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const leak = sw.findTitleLeak(line);
    if (!leak) continue;
    const idx = line.toLowerCase().indexOf(String(leak).toLowerCase());
    if (idx > 0 && NEGATION.test(line.slice(0, idx))) continue;
    out.push({ source: sourceName, layer: 'TITLE(findTitleLeak)', term: leak, line: li + 1, text: line.trim().slice(0, 110) });
  }
  // Them: quet tho RESCUER_NOUNS / ENDING_PHRASES nhung CHI trong khoi mo ta WEB_TITLE
  // (day la cho duy nhat template co the "day" cach dat tieu de).
  const m = String(text || '').match(/===WEB_TITLE===\r?\n([\s\S]*?)(?:\r?\n===)/);
  if (m) {
    const block = m[1];
    scanPhrases('TITLE.RESCUER_NOUNS', block, sw.RESCUER_NOUNS || [], sourceName, out);
    scanPhrases('TITLE.ENDING_PHRASES', block, sw.ENDING_PHRASES || [], sourceName, out);
  }
}

// Cum KHUYEN KHICH artifact/canvas — template TUYET DOI khong duoc day (app doc chat, khong
// doc artifact). Xu ly phu dinh -> "KHONG tao artifact" hop le, chi bat khi DAY dung.
const ARTIFACT_BANNED = ['create an artifact', 'use an artifact', 'as an artifact', 'in a canvas',
  'use the canvas', 'as a document', 'in a document', 'tạo artifact', 'dùng canvas', 'dùng artifact',
  'gói vào artifact', 'xuất ra artifact', 'viết vào artifact'];

function scanTemplate(text, sourceName) {
  const out = [];
  scanPhrases('CTA.BEG (xin tương tác)', text, sw.CTA_BEG_PHRASES || [], sourceName, out);
  scanPhrases('CTA.SPOIL (lộ nội dung sau)', text, sw.CTA_SPOIL_PHRASES || [], sourceName, out);
  scanPhrases('IMAGE (bộ lọc AI vẽ)', text, sw.IMAGE_BANNED || [], sourceName, out);
  scanPhrases('ARTIFACT (app chỉ đọc chat)', text, ARTIFACT_BANNED, sourceName, out);
  scanTitleRules(text, sourceName, out);
  return out;
}

// Dam bao DEFAULT_SKILL_COMMAND CO dong cam artifact (thieu -> canh bao, khong fail).
function checkAntiArtifactPresent() {
  const t = sw.DEFAULT_SKILL_COMMAND || '';
  const has = /KHÔNG tạo artifact/i.test(t) || /không.*artifact.*không.*canvas/i.test(t);
  return has;
}

// ---- Nguon template: DEFAULT + ban da luu trong settings (neu co) ----
function savedTemplate() {
  try {
    const os = require('os');
    const fs = require('fs');
    const p = path.join(os.homedir(), 'AppData', 'Roaming', 'story-factory', 'data', 'settings.json');
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = s && s.story && s.story.skillCommand;
    return (typeof t === 'string' && t.trim()) ? t : null;
  } catch (_) { return null; }
}

const sources = [['DEFAULT_SKILL_COMMAND', sw.DEFAULT_SKILL_COMMAND]];
const saved = savedTemplate();
if (saved) sources.push(['settings.story.skillCommand (bản đã lưu)', saved]);

let all = [];
for (const [name, text] of sources) all = all.concat(scanTemplate(text, name));

const counts = (sw.CTA_BEG_PHRASES || []).length + (sw.CTA_SPOIL_PHRASES || []).length
  + (sw.IMAGE_BANNED || []).length + (sw.RESCUER_NOUNS || []).length + (sw.ENDING_PHRASES || []).length;

console.log('=== GUARD TEMPLATE ===');
console.log('Nguồn quét : ' + sources.map((s) => s[0]).join(' | '));
console.log('Cụm cấm    : ' + (counts + ARTIFACT_BANNED.length) + ' (đọc thẳng từ story-writer.js, không chép lại)');
// Canh bao (khong fail) neu THIEU dong cam artifact — de template luon co lop chan thu 2.
if (!checkAntiArtifactPresent()) {
  console.log('⚠️  CẢNH BÁO : DEFAULT_SKILL_COMMAND THIẾU dòng cấm artifact — nên thêm "KHÔNG tạo artifact".');
} else {
  console.log('Anti-artifact: ✓ template có dòng cấm artifact/canvas.');
}
if (!all.length) {
  console.log('KẾT QUẢ    : ✓ SẠCH — template không dạy Claude thứ mà app đang cấm.');
  process.exit(0);
}
console.log('KẾT QUẢ    : ✗ ' + all.length + ' VI PHẠM — template đang DẠY Claude làm điều app sẽ từ chối:');
console.log('');
for (const v of all) {
  console.log(`  [${v.layer}] "${v.term}"`);
  console.log(`     ${v.source} — dòng ${v.line}: ${v.text}`);
}
console.log('');
console.log('Sửa template cho khớp luật, hoặc viết lại dưới dạng CẤM (⛔/KHÔNG/not) nếu là lời dặn.');
process.exit(1);
