'use strict';

/**
 * TAO ANH bang Gemini API roi UP len Cloudflare R2 (S3-compatible, ky AWS SigV4).
 *
 *  - generateImage(prompt, {apiKey})  -> goi Gemini, tra ve buffer anh (base64 -> Buffer).
 *  - uploadToR2({...})                -> PUT anh len R2, ky chuan SigV4 (khong dung SDK).
 *  - createAndUpload({...})           -> gop 2 buoc, tra { ok, url } | { ok:false, error }.
 *
 * NGUYEN TAC: MOI loi (Gemini/R2) deu bat va tra ve {ok:false,error}, KHONG throw
 * -> khong lam sap tien trinh viet bai. Key/secret lay tu store (KHONG hardcode).
 *
 * Gemini image model: gemini-2.5-flash-image (tra anh trong inlineData).
 * R2: PUT {endpoint}/{bucket}/{key}, region 'auto', service 's3'.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GEMINI_MODEL = 'gemini-2.5-flash-image';

// Backoff cho retry khi dinh rate-limit (429) / qua tai (503): 15s, 30s, 60s, 90s -> toi da 4 lan.
const RETRY_BACKOFFS_MS = [15000, 30000, 60000, 90000];

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function log(logger, msg) {
  try { (logger || (() => {}))(msg); } catch (_) {}
  try { console.log('[image-gen] ' + msg); } catch (_) {}
}

// ---------------- GEMINI ----------------
async function generateImage(prompt, { apiKey } = {}, logger) {
  if (!apiKey) return { ok: false, error: 'Chưa cấu hình Gemini API Key' };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'Prompt ảnh rỗng' };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: String(prompt) }] }] });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, // key trong header, KHONG trong URL
      body,
    });
  } catch (e) {
    return { ok: false, error: 'Gọi Gemini lỗi mạng: ' + e.message };
  }

  const txt = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: `Gemini HTTP ${res.status}: ${txt.slice(0, 300)}` };

  let data;
  try { data = JSON.parse(txt); } catch (_) { return { ok: false, error: 'Gemini trả về không phải JSON' }; }

  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const img = parts.find((p) => p && p.inlineData && p.inlineData.data);
  if (!img) {
    const reason = (data && data.promptFeedback && data.promptFeedback.blockReason)
      || (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason)
      || 'không có ảnh trả về';
    return { ok: false, error: 'Gemini không trả ảnh (' + reason + ')' };
  }

  const mimeType = img.inlineData.mimeType || 'image/png';
  const buffer = Buffer.from(img.inlineData.data, 'base64');
  if (!buffer.length) return { ok: false, error: 'Gemini trả ảnh rỗng' };
  return { ok: true, buffer, mimeType };
}

// ---------------- R2 (S3 SigV4) ----------------
function sha256hex(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest(); }
// Ma hoa tung segment cua path theo chuan AWS (khong dong cham '/')
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

// ---------------- GOP: tao anh -> up R2 -> tra link cong khai ----------------
/**
 * @param {object} p
 *   prompt, storyId, kind ('fb'|'p1'|'p2'|'p3'), cfg {geminiKey, r2AccessKeyId, r2SecretAccessKey, r2Endpoint, r2Bucket, r2PublicDomain}
 * @returns {Promise<{ok:true,url:string}|{ok:false,error:string}>}
 */
async function createAndUpload({ prompt, storyId, kind, cfg }, logger) {
  cfg = cfg || {};
  if (!cfg.geminiKey || !cfg.r2Endpoint || !cfg.r2AccessKeyId || !cfg.r2SecretAccessKey || !cfg.r2Bucket || !cfg.r2PublicDomain) {
    return { ok: false, error: 'Chưa cấu hình đủ Gemini/R2 (Cài đặt → Ảnh & Lưu trữ)', notConfigured: true };
  }

  log(logger, `Tạo ảnh ${kind} cho ${storyId}...`);
  // Goi Gemini co RETRY khi 429 (rate-limit) / 503 (qua tai): doi tang dan 15s,30s,60s,90s (toi da 4 lan).
  // Loi khac (400, khong co anh, mang...) -> bo qua anh nay, KHONG retry.
  let gen;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    gen = await generateImage(prompt, { apiKey: cfg.geminiKey }, logger);
    if (gen.ok) break;
    const retryable = gen.status === 429 || gen.status === 503;
    if (retryable && attempt < RETRY_BACKOFFS_MS.length) {
      const waitMs = RETRY_BACKOFFS_MS[attempt];
      log(logger, `⏳ Gemini ${gen.status} — đang đợi ${waitMs / 1000} giây rồi thử lại ảnh ${kind} (lần ${attempt + 1}/${RETRY_BACKOFFS_MS.length}, 429).`);
      await delay(waitMs);
      continue;
    }
    break; // het luot retry, hoac loi khong the retry
  }
  if (!gen.ok) { log(logger, `✗ Gemini ${kind}: ${gen.error}`); return { ok: false, error: gen.error }; }

  // Ten file theo quy uoc: {story_id thuong}-{kind}.jpg  (vd st00000001-fb.jpg)
  const key = `${String(storyId).toLowerCase()}-${kind}.jpg`;

  // Luu tam de tien chan doan khi loi (khong bat buoc cho viec up)
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

module.exports = { generateImage, uploadToR2, createAndUpload, GEMINI_MODEL };
