'use strict';

/**
 * TAO ANH bang CLOUDFLARE WORKERS AI (model FLUX 2 klein-9b) roi UP len Cloudflare R2.
 *
 * (Truoc day dung Gemini API - da bo vi free tier luon dinh 429.)
 *
 *  - generateImage(prompt, {accountId, apiToken, width, height}) -> buffer anh
 *  - uploadToR2({...})        -> PUT anh len R2, ky chuan AWS SigV4 (khong dung SDK)
 *  - createAndUpload({...})   -> gop 2 buoc, tra { ok, url } | { ok:false, error }
 *
 * NGUYEN TAC: MOI loi deu bat va tra ve {ok:false,error}, KHONG throw
 * -> khong lam sap tien trinh viet bai. Key/token lay tu store (KHONG hardcode).
 *
 * LUU Y QUAN TRONG (da kiem chung khi test):
 *  - Model FLUX 2 BAT BUOC gui multipart/form-data, KHONG nhan JSON.
 *  - Model co BO LOC NOI DUNG rieng: doi khi tu choi anh no vua sinh (code 3030
 *    "Your output has been flagged"). Gap loi nay thi BO QUA anh do, KHONG tu dong
 *    thu lai nhieu lan (khong lach bo loc cua nha cung cap).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CF_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';

// Kich thuoc theo tung loai anh: fb vuong, anh web ngang
const SIZE_BY_KIND = {
  fb: { width: 1024, height: 1024 },
  p1: { width: 1280, height: 720 },
  p2: { width: 1280, height: 720 },
  p3: { width: 1280, height: 720 },
};
const DEFAULT_SIZE = { width: 1024, height: 1024 };

// Backoff khi dinh gioi han tan suat (429) / qua tai (503). KHONG ap dung cho bo loc 3030.
const RETRY_BACKOFFS_MS = [15000, 30000, 60000, 90000];

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function log(logger, msg) {
  try { (logger || (() => {}))(msg); } catch (_) {}
  try { console.log('[image-gen] ' + msg); } catch (_) {}
}

// Phan hoi co phai bi BO LOC NOI DUNG chan khong (code 3030)
function isFlagged(text) {
  return /has been flagged|"code"\s*:\s*3030/i.test(String(text || ''));
}

// ---------------- CLOUDFLARE WORKERS AI ----------------
/**
 * Goi Workers AI tao 1 anh.
 * @returns {ok:true,buffer,mimeType} | {ok:false,error,status?,flagged?}
 */
async function generateImage(prompt, { accountId, apiToken, width, height } = {}) {
  if (!accountId || !apiToken) return { ok: false, error: 'Chưa cấu hình Cloudflare Account ID / API Token' };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'Prompt ảnh rỗng' };

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`;

  // FLUX 2 yeu cau multipart/form-data (khong nhan JSON)
  const fd = new FormData();
  fd.append('prompt', String(prompt));
  fd.append('width', String(width || DEFAULT_SIZE.width));
  fd.append('height', String(height || DEFAULT_SIZE.height));

  let res;
  try {
    // KHONG tu dat Content-Type: de fetch tu sinh boundary cho multipart
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` }, body: fd });
  } catch (e) {
    return { ok: false, error: 'Gọi Cloudflare lỗi mạng: ' + e.message };
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    if (isFlagged(body)) {
      return {
        ok: false, flagged: true, status: res.status,
        error: 'Bị bộ lọc nội dung của model chặn (code 3030) — model tự từ chối ảnh nó vừa sinh. Không phải lỗi phần mềm.',
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: `Cloudflare từ chối (HTTP ${res.status}) — sai Account ID hoặc API Token, hoặc token thiếu quyền Workers AI.` };
    }
    return { ok: false, status: res.status, error: `Cloudflare HTTP ${res.status}: ${body.slice(0, 300)}` };
  }

  // Boc anh: co the la JSON base64 hoac binary
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { return { ok: false, error: 'Cloudflare trả về JSON hỏng' }; }
    if (isFlagged(text)) {
      return { ok: false, flagged: true, error: 'Bị bộ lọc nội dung của model chặn (code 3030).' };
    }
    const r = data && data.result;
    let b64 = null;
    if (r && typeof r === 'object') {
      if (typeof r.image === 'string') b64 = r.image;
      else if (Array.isArray(r.images) && typeof r.images[0] === 'string') b64 = r.images[0];
    } else if (typeof r === 'string') b64 = r;
    if (!b64) {
      const errs = data && data.errors ? JSON.stringify(data.errors) : text.slice(0, 200);
      return { ok: false, error: 'Không tìm thấy ảnh trong phản hồi Cloudflare: ' + errs };
    }
    b64 = b64.replace(/^data:image\/[a-z]+;base64,/i, '');
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) return { ok: false, error: 'Ảnh trả về rỗng' };
    return { ok: true, buffer, mimeType: 'image/jpeg' };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) return { ok: false, error: 'Ảnh trả về rỗng' };
  return { ok: true, buffer, mimeType: ct || 'image/jpeg' };
}

// ---------------- R2 (S3 SigV4) — GIU NGUYEN, da test dung chuan AWS ----------------
function sha256hex(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest(); }
function uriEncodeSegment(seg) {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function uploadToR2({ endpoint, accessKeyId, secretAccessKey, bucket, key, body, contentType }, logger) {
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return { ok: false, error: 'Thiếu cấu hình R2 (endpoint / access key / secret / bucket)' };
  }
  let u;
  try { u = new URL(endpoint); } catch (_) { return { ok: false, error: 'R2 Endpoint không hợp lệ' }; }

  const host = u.host;
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);

  const canonicalUri = '/' + uriEncodeSegment(bucket) + '/' + String(key).split('/').map(uriEncodeSegment).join('/');
  const payloadHash = sha256hex(body);
  const ct = contentType || 'application/octet-stream';

  const canonicalHeaders =
    `content-type:${ct}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzdate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');

  let signingKey = hmac('AWS4' + secretAccessKey, datestamp);
  signingKey = hmac(signingKey, region);
  signingKey = hmac(signingKey, service);
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const putUrl = `${u.origin}${canonicalUri}`;
  let res;
  try {
    res = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': ct,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzdate,
        Authorization: authorization,
      },
      body,
    });
  } catch (e) {
    return { ok: false, error: 'Up R2 lỗi mạng: ' + e.message };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `R2 HTTP ${res.status}: ${t.slice(0, 300)}` };
  }
  return { ok: true };
}

// ---------------- GOP: tao anh -> luu tam -> up R2 -> tra link ----------------
/**
 * @param {object} p
 *   prompt (LAY NGUYEN tu cot skill da viet - phan mem KHONG tu che prompt),
 *   storyId, kind ('fb'|'p1'|'p2'|'p3'),
 *   cfg {cfAccountId, cfApiToken, r2AccessKeyId, r2SecretAccessKey, r2Endpoint, r2Bucket, r2PublicDomain}
 */
async function createAndUpload({ prompt, storyId, kind, cfg }, logger) {
  cfg = cfg || {};
  if (!cfg.cfAccountId || !cfg.cfApiToken || !cfg.r2Endpoint || !cfg.r2AccessKeyId
      || !cfg.r2SecretAccessKey || !cfg.r2Bucket || !cfg.r2PublicDomain) {
    return { ok: false, error: 'Chưa cấu hình đủ Cloudflare/R2 (Cài đặt → Ảnh & Lưu trữ)', notConfigured: true };
  }

  const size = SIZE_BY_KIND[kind] || DEFAULT_SIZE;
  log(logger, `Tạo ảnh ${kind} (${size.width}x${size.height}) cho ${storyId}...`);

  // Retry CHI cho 429/503 (gioi han tan suat). KHONG retry loi bo loc 3030.
  let gen;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    gen = await generateImage(prompt, {
      accountId: cfg.cfAccountId, apiToken: cfg.cfApiToken,
      width: size.width, height: size.height,
    });
    if (gen.ok) break;
    if (gen.flagged) break; // bo loc noi dung -> bo qua luon, khong thu lai
    const retryable = gen.status === 429 || gen.status === 503;
    if (retryable && attempt < RETRY_BACKOFFS_MS.length) {
      const waitMs = RETRY_BACKOFFS_MS[attempt];
      log(logger, `⏳ Cloudflare ${gen.status} — đang đợi ${waitMs / 1000} giây rồi thử lại ảnh ${kind} (lần ${attempt + 1}/${RETRY_BACKOFFS_MS.length}).`);
      await delay(waitMs);
      continue;
    }
    break;
  }

  if (!gen.ok) {
    if (gen.flagged) {
      log(logger, `⊘ Ảnh ${kind}: BỊ BỘ LỌC NỘI DUNG CHẶN (code 3030). Model tự từ chối ảnh vừa sinh — không phải lỗi phần mềm, không phải lỗi token. Bỏ qua ảnh này, bài vẫn được đẩy.`);
    } else {
      log(logger, `✗ Ảnh ${kind}: ${gen.error}`);
    }
    return { ok: false, error: gen.error, flagged: !!gen.flagged };
  }

  // Ten file theo quy uoc: {story_id thuong}-{kind}.jpg  (vd st00000001-fb.jpg)
  const key = `${String(storyId).toLowerCase()}-${kind}.jpg`;

  // Luu tam (tien chan doan khi loi) - khong bat buoc cho viec up
  try {
    const tmp = path.join(os.tmpdir(), 'story-factory-img', key);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, gen.buffer);
  } catch (_) { /* bo qua neu khong ghi duoc tam */ }

  const up = await uploadToR2({
    endpoint: cfg.r2Endpoint,
    accessKeyId: cfg.r2AccessKeyId,
    secretAccessKey: cfg.r2SecretAccessKey,
    bucket: cfg.r2Bucket,
    key,
    body: gen.buffer,
    contentType: gen.mimeType || 'image/jpeg',
  }, logger);
  if (!up.ok) { log(logger, `✗ R2 ${kind}: ${up.error}`); return { ok: false, error: up.error }; }

  const base = String(cfg.r2PublicDomain).replace(/\/+$/, '');
  const url = `${base}/${key}`;
  log(logger, `✓ Ảnh ${kind}: ${url}`);
  return { ok: true, url };
}

module.exports = { generateImage, uploadToR2, createAndUpload, CF_MODEL, SIZE_BY_KIND };
