'use strict';

/**
 * SO SANH 3 BIEN THE PROMPT tren model @cf/black-forest-labs/flux-2-klein-9b
 * (Cloudflare Workers AI) - de tim prompt cho ra anh GIONG ANH CHUP THAT nhat,
 * bot kieu "qua net / qua dien anh / AI".
 *
 * File NAY DOC LAP hoan toan voi phan mem chinh (khong import, khong sua gi cua app).
 *
 * Chay:
 *   node test-flux.js                 -> chay ca 3 bien the A, B, C
 *   node test-flux.js --only B        -> chi chay bien the B (khong ghi de anh khac)
 *   node test-flux.js --only AC       -> chi chay A va C
 *   node test-flux.js <accountId> <apiToken>
 *
 * Token KHONG hardcode: doc tu dong lenh, hoac tu file .flux-test.json cung thu muc.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG_FILE = path.join(ROOT, '.flux-test.json');
const OUT_DIR = path.join(ROOT, 'flux-test-output');

// CHI 1 model (gui multipart/form-data)
const MODEL = '@cf/black-forest-labs/flux-2-klein-9b';
const WIDTH = 1024;
const HEIGHT = 1024;
const GAP_MS = 3000; // nghi giua 2 lan goi cho do dinh gioi han tan suat

// 3 bien the prompt - cung boi canh (ong gia + tui do nghe), khac PHONG CACH ANH
const VARIANTS = [
  {
    id: 'A',
    label: 'Dien anh (cinematic - de doi chieu)',
    file: 'klein9b-A-cinematic.jpg',
    prompt: 'Square photo, cinematic photorealistic emotional family drama. A 64-year-old working-class American man with weathered face and gray hair kneels on a polished marble mansion floor, reaching for his old cracked-leather toolbag after it was thrown down. His face shows restrained humiliation, not crying. Behind him his wealthy nephew in an expensive dark suit stands with a cold dismissive expression. Several well-dressed family members watch awkwardly. Dramatic chandelier lighting, restrained emotion, natural faces, not theatrical, no text.',
  },
  {
    id: 'B',
    label: 'Anh chup that (candid / documentary)',
    file: 'klein9b-B-documentary.jpg',
    prompt: 'Candid documentary photograph, shot on Canon 5D 35mm lens, natural imperfect indoor lighting, subtle film grain, realistic skin texture with visible pores and wrinkles, slightly soft focus, amateur snapshot feel. A 64-year-old working-class American man with weathered face and gray hair kneels on a marble mansion floor, reaching for his old cracked-leather toolbag after it was thrown down, face showing quiet restrained humiliation. Behind him his wealthy nephew in a dark suit stands with a cold dismissive look. Well-dressed family members watch awkwardly. Not theatrical, not over-sharp, no text.',
  },
  {
    id: 'C',
    label: 'Dien thoai chup len (raw / phone)',
    file: 'klein9b-C-phone.jpg',
    prompt: 'Raw candid smartphone photo, slightly grainy, natural available light, imperfect composition, realistic everyday feel, authentic skin texture. A 64-year-old working-class American man with weathered tired face kneels on a marble mansion floor picking up his old worn leather toolbag from the floor, expression of quiet shame. Nearby a younger wealthy man in a suit looks down coldly. Family members in formal clothes stand watching. Documentary style, not cinematic, not polished, no text.',
  },
];

// Chi chay 1 vai bien the:  node test-flux.js --only B   (hoac --only BC)
// Huu ich khi 1 bien the bi bo loc chan: chay lai rieng no, KHONG ghi de cac anh da co.
function pickVariants() {
  const i = process.argv.indexOf('--only');
  const sel = i >= 0 ? String(process.argv[i + 1] || '').toUpperCase() : '';
  if (!sel) return VARIANTS;
  const picked = VARIANTS.filter((v) => sel.includes(v.id));
  return picked.length ? picked : VARIANTS;
}

// ---------------- Tien ich ----------------
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtMB(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}
function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }

function printSetupHelp(reason) {
  console.log('');
  console.log('==================================================================');
  console.log('  CHUA CO THONG TIN DANG NHAP CLOUDFLARE' + (reason ? ' (' + reason + ')' : ''));
  console.log('==================================================================');
  console.log('');
  console.log('Cach 1 - tao file  .flux-test.json  trong thu muc:');
  console.log('  ' + ROOT);
  console.log('voi noi dung:');
  console.log('');
  console.log('{');
  console.log('  "accountId": "dan_account_id_cua_ban_vao_day",');
  console.log('  "apiToken": "dan_api_token_cua_ban_vao_day"');
  console.log('}');
  console.log('');
  console.log('Cach 2 - truyen thang tren dong lenh:');
  console.log('  node test-flux.js <accountId> <apiToken>');
  console.log('');
  console.log('LUU Y: khong chia se / khong commit file .flux-test.json len GitHub.');
  console.log('');
}

function loadCreds() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  // bo qua gia tri di kem --only (vd: "B") de khong nham voi accountId
  const onlyIdx = process.argv.indexOf('--only');
  const onlyVal = onlyIdx >= 0 ? String(process.argv[onlyIdx + 1] || '') : null;
  const clean = onlyVal ? args.filter((a) => a !== onlyVal) : args;

  if (clean.length >= 2 && clean[0].trim() && clean[1].trim()) {
    return { accountId: clean[0].trim(), apiToken: clean[1].trim(), from: 'dong lenh' };
  }
  if (!fs.existsSync(CFG_FILE)) { printSetupHelp('khong thay file .flux-test.json'); return null; }
  let raw;
  try { raw = fs.readFileSync(CFG_FILE, 'utf8'); }
  catch (e) { printSetupHelp('khong doc duoc .flux-test.json: ' + e.message); return null; }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { printSetupHelp('.flux-test.json khong phai JSON hop le: ' + e.message); return null; }
  const accountId = String(j.accountId || '').trim();
  const apiToken = String(j.apiToken || '').trim();
  if (!accountId || !apiToken) { printSetupHelp('.flux-test.json thieu "accountId" hoac "apiToken"'); return null; }
  return { accountId, apiToken, from: '.flux-test.json' };
}

// Gui multipart/form-data (model FLUX 2 bat buoc kieu nay)
function sendMultipart(url, apiToken, prompt, withSize) {
  const fd = new FormData();
  fd.append('prompt', prompt);
  if (withSize) { fd.append('width', String(WIDTH)); fd.append('height', String(HEIGHT)); }
  // KHONG tu dat Content-Type: de fetch tu sinh boundary
  return fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` }, body: fd });
}

// Boc anh: model co the tra JSON base64 hoac binary
async function extractImage(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { return { ok: false, error: 'Phan hoi JSON hong' }; }
    const r = data && data.result;
    let b64 = null;
    if (r && typeof r === 'object') {
      if (typeof r.image === 'string') b64 = r.image;
      else if (Array.isArray(r.images) && typeof r.images[0] === 'string') b64 = r.images[0];
    } else if (typeof r === 'string') b64 = r;
    if (!b64) {
      const errs = data && data.errors ? JSON.stringify(data.errors) : text.slice(0, 200);
      return { ok: false, error: 'Khong tim thay anh trong JSON: ' + errs };
    }
    b64 = b64.replace(/^data:image\/[a-z]+;base64,/i, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { ok: false, error: 'Anh base64 rong' };
    return { ok: true, buffer: buf, kind: 'JSON base64' };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { ok: false, error: 'Anh binary rong' };
  return { ok: true, buffer: buf, kind: 'binary ' + (ct || 'khong ro') };
}

function isFlagged(body) { return /has been flagged|"code":\s*3030/i.test(body || ''); }

// ---------------- Chay 1 bien the ----------------
async function runVariant(v, creds) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${MODEL}`;
  const started = Date.now();

  let res;
  let sizeMode = WIDTH + 'x' + HEIGHT;
  try {
    res = await sendMultipart(url, creds.apiToken, v.prompt, true);
  } catch (e) {
    return { v, status: 'LOI', ms: Date.now() - started, reason: 'Loi mang: ' + e.message };
  }

  // Neu model khong chap nhan width/height -> gui lai khong kem kich thuoc
  if (!res.ok && res.status === 400) {
    let peek = '';
    try { peek = await res.clone().text(); } catch (_) {}
    if (!isFlagged(peek) && /width|height|size|propert/i.test(peek)) {
      console.log('        (model khong nhan width/height - gui lai o kich thuoc mac dinh...)');
      sizeMode = 'mac dinh';
      try { res = await sendMultipart(url, creds.apiToken, v.prompt, false); }
      catch (e) { return { v, status: 'LOI', ms: Date.now() - started, reason: 'Loi mang: ' + e.message }; }
    }
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    const ms = Date.now() - started;

    if (res.status === 401 || res.status === 403) {
      return { v, status: 'LOI', ms, fatal: true,
        reason: 'API Token SAI hoac KHONG DU QUYEN (HTTP ' + res.status + ').\n' +
                '        -> Kiem tra apiToken va accountId. Token can quyen: Account > Workers AI.' };
    }
    if (res.status === 429) {
      return { v, status: 'LOI', ms,
        reason: 'HET QUOTA / BI GIOI HAN TAN SUAT (HTTP 429).\n' +
                '        -> Doi it phut roi chay lai.' };
    }
    if (isFlagged(body)) {
      return { v, status: 'CHAN', ms,
        reason: 'BI BO LOC NOI DUNG CUA MODEL CHAN (code 3030).\n' +
                '        -> Model tu sinh anh roi tu cham la nhay cam nen khong tra ve.\n' +
                '        -> KHONG phai loi phan mem, khong phai loi token.\n' +
                '        -> Neu chay lai van bi: doi cach ta trong prompt, vi du bo\n' +
                '           "kneels / humiliation" -> "bends down to pick up his toolbag,\n' +
                '           quiet dignified sadness".' };
    }
    return { v, status: 'LOI', ms, reason: 'HTTP ' + res.status + ': ' + body.slice(0, 300) };
  }

  const img = await extractImage(res);
  const ms = Date.now() - started;
  if (!img.ok) {
    if (isFlagged(img.error)) {
      return { v, status: 'CHAN', ms, reason: 'BI BO LOC NOI DUNG CHAN (code 3030).' };
    }
    return { v, status: 'LOI', ms, reason: img.error };
  }

  const file = path.join(OUT_DIR, v.file);
  try { fs.writeFileSync(file, img.buffer); }
  catch (e) { return { v, status: 'LOI', ms, reason: 'Khong ghi duoc file: ' + e.message }; }

  return { v, status: 'OK', ms, file, bytes: img.buffer.length, kind: img.kind, sizeMode };
}

// ---------------- Main ----------------
(async () => {
  console.log('');
  console.log('=== SO SANH BIEN THE PROMPT - tim anh "doi" nhat ===');
  console.log('Model: ' + MODEL);

  const creds = loadCreds();
  if (!creds) process.exit(1);

  console.log('Nguon dang nhap : ' + creds.from);
  console.log('Account ID      : ' + creds.accountId.slice(0, 6) + '...' + creds.accountId.slice(-4));
  console.log('Kich thuoc      : ' + WIDTH + 'x' + HEIGHT);
  console.log('Thu muc luu anh : ' + OUT_DIR);
  console.log('');

  try { fs.mkdirSync(OUT_DIR, { recursive: true }); }
  catch (e) { console.log('Khong tao duoc thu muc output: ' + e.message); process.exit(1); }

  const RUN = pickVariants();
  if (RUN.length !== VARIANTS.length) {
    console.log('Chi chay bien the: ' + RUN.map((v) => v.id).join(', ') + '  (cac anh khac giu nguyen)');
    console.log('');
  }

  const results = [];
  for (let i = 0; i < RUN.length; i++) {
    const v = RUN[i];
    console.log('[' + (i + 1) + '/' + RUN.length + '] Bien the ' + v.id + ' - ' + v.label);
    console.log('        Dang tao anh, vui long doi...');
    const r = await runVariant(v, creds);
    results.push(r);

    if (r.status === 'OK') {
      console.log('        [OK] THANH CONG - ' + fmtSec(r.ms) + ' - ' + fmtMB(r.bytes) + ' - (' + r.sizeMode + ', ' + r.kind + ')');
      console.log('          File: ' + r.file);
    } else if (r.status === 'CHAN') {
      console.log('        [BI CHAN] ' + r.reason);
    } else {
      console.log('        [LOI] ' + r.reason);
    }
    console.log('');

    if (r.fatal) { console.log('Dung lai vi loi xac thuc (cac bien the sau cung se loi).'); console.log(''); break; }
    // BI CHAN thi VAN chay tiep bien the sau
    if (i < RUN.length - 1) await delay(GAP_MS);
  }

  // ---------------- Tong ket ----------------
  console.log('==================================================================');
  console.log('  TONG KET');
  console.log('==================================================================');
  const ok = results.filter((r) => r.status === 'OK');
  const blocked = results.filter((r) => r.status === 'CHAN');
  const failed = results.filter((r) => r.status === 'LOI');

  console.log('');
  if (ok.length) {
    console.log('TAO DUOC ANH (' + ok.length + '/' + RUN.length + '):');
    ok.forEach((r) => {
      console.log('  [OK] ' + r.v.id + '  ' + r.v.label.padEnd(38) + fmtSec(r.ms).padStart(7) + '  ' + fmtMB(r.bytes).padStart(9) + '  ->  ' + r.v.file);
    });
  } else {
    console.log('KHONG tao duoc anh nao.');
  }

  if (blocked.length) {
    console.log('');
    console.log('BI BO LOC CHAN:');
    blocked.forEach((r) => console.log('  [CHAN] ' + r.v.id + '  ' + r.v.label));
    console.log('  -> Chay lai rieng: node test-flux.js --only ' + blocked.map((r) => r.v.id).join(''));
  }
  if (failed.length) {
    console.log('');
    console.log('LOI:');
    failed.forEach((r) => console.log('  [LOI] ' + r.v.id + '  ' + String(r.reason).split('\n')[0]));
  }

  if (ok.length) {
    console.log('');
    console.log('MO THU MUC NAY DE SO ANH BANG MAT:');
    console.log('  ' + OUT_DIR);
    console.log('');
    console.log('  A = dien anh (chuan cu)  |  B = anh chup tai lieu  |  C = dien thoai chup len');
  }
  console.log('');
  process.exit(ok.length ? 0 : 1);
})();
