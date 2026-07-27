'use strict';

/**
 * DIEU PHOI NGUON TAO ANH: thu lan luot theo THU TU UU TIEN (mac dinh gemini -> chatgpt
 * -> cloudflare), nguon nao ra anh thi UP R2 (dung lai SigV4 trong image-gen.js) roi tra link.
 *
 *  - gemini / chatgpt : tao anh MIEN PHI qua dieu khien cua so (image-webgen.js).
 *  - cloudflare       : API tra tien cu (image-gen.js) - GIU LAI phong khi can.
 *
 * Quy tac chuyen nguon:
 *  - het quota / loi / khong tao duoc  -> thu NGUON KE TIEP.
 *  - bi bo loc noi dung (flagged)      -> thu nguon ke (nguon khac co the de hon);
 *    het nguon van bi -> bao flagged de danh dau need_image (KHONG sap bai).
 *  - R2 up loi -> dung luon (doi nguon khong giup vi loi la o R2/cau hinh).
 */

const imageGen = require('./image-gen');
const imageWebgen = require('./image-webgen');

const DEFAULT_ORDER = ['gemini', 'chatgpt', 'cloudflare'];
const DEFAULT_ENABLED = { gemini: true, chatgpt: true, cloudflare: false };

// ---- CAU DAO TU THICH UNG (pham vi 1 BAI, ap cho MOI nguon, KHONG hardcode) ----
// Nguon NAO fail 2 lan lien tiep trong 1 bai -> BO nguon do cho cac anh con lai cua bai,
// uu tien nguon con hoat dong. Ra anh thanh cong -> reset chuoi fail cua nguon do.
// Trang thai song suot 1 bai; bai sau tao moi (makeCircuit) -> thu lai ca 2 nguon tu dau
// (Gemini/ChatGPT co the hoi phuc quota o bai sau). Logic THUAN, test duoc.
function makeCircuit(threshold = 2) { return { fail: {}, disabled: new Set(), threshold }; }
function circuitAllows(state, source) { return !state || !state.disabled.has(source); }
// Ghi ket qua 1 lan thu; tra ve true NEU vua moi ngat nguon (de log).
function circuitRecord(state, source, ok) {
  if (!state) return false;
  if (ok) { state.fail[source] = 0; return false; }
  state.fail[source] = (state.fail[source] || 0) + 1;
  if (state.fail[source] >= (state.threshold || 2) && !state.disabled.has(source)) {
    state.disabled.add(source); return true;
  }
  return false;
}

// Danh sach nguon da BAT, theo dung thu tu uu tien
function orderedSources(cfg) {
  const src = (cfg && cfg.source) || {};
  const order = Array.isArray(src.order) && src.order.length ? src.order : DEFAULT_ORDER;
  const enabled = src.enabled || DEFAULT_ENABLED;
  const seen = new Set();
  return order.filter((s) => enabled[s] && !seen.has(s) && seen.add(s));
}

// Tao 1 anh bang 1 nguon cu the -> {ok, buffer, mimeType} | {ok:false, error, quota?, flagged?, skip?}
async function genOne(source, prompt, kind, cfg, log) {
  if (source === 'cloudflare') {
    if (!cfg.cfAccountId || !cfg.cfApiToken) return { ok: false, skip: true, error: 'Cloudflare chưa cấu hình key' };
    const size = imageGen.SIZE_BY_KIND[kind] || { width: 1024, height: 1024 };
    return imageGen.generateImage(prompt, { accountId: cfg.cfAccountId, apiToken: cfg.cfApiToken, width: size.width, height: size.height });
  }
  if (source === 'gemini' || source === 'chatgpt') {
    const show = !!(cfg.source && cfg.source.showWindow);
    // CHAN DOAN cua so an/hien: in ra cfg.source that su nhan duoc luc chay (biet showWindow co toi khong)
    log(`[${source}] 🔬 cfg.source=${JSON.stringify(cfg.source || null)} → show=${show}`);
    return imageWebgen.generate(source, prompt, { show, log });
  }
  return { ok: false, skip: true, error: 'Nguồn không hỗ trợ: ' + source };
}

/**
 * @param {object} p prompt, storyId, kind ('fb'|'thumb'|'p1'|'p2'|'p3'), cfg
 * @returns {ok:true,url,source} | {ok:false,error,flagged?,notConfigured?}
 */
async function createAndUpload({ prompt, storyId, kind, cfg, circuit }, logger) {
  cfg = cfg || {};
  const log = (m) => { try { (logger || (() => {}))(m); } catch (_) {} };

  // R2 bat buoc (noi luu anh chung cho moi nguon)
  if (!cfg.r2Endpoint || !cfg.r2AccessKeyId || !cfg.r2SecretAccessKey || !cfg.r2Bucket || !cfg.r2PublicDomain) {
    return { ok: false, error: 'Chưa cấu hình đủ R2 (Cài đặt → Ảnh & Lưu trữ)', notConfigured: true };
  }
  // Cau dao: neu khong truyen -> tao moi moi lan (khong nho xuyen anh, = hanh vi cu).
  const cb = circuit || makeCircuit();
  const allSources = orderedSources(cfg);
  if (!allSources.length) return { ok: false, error: 'Chưa bật nguồn tạo ảnh nào (Cài đặt → Nguồn ảnh)', notConfigured: true };
  const sources = allSources.filter((s) => circuitAllows(cb, s));
  if (!sources.length) {
    return { ok: false, error: 'Các nguồn ảnh đều đã bị cầu dao ngắt trong bài này (fail liên tiếp).' };
  }

  let lastErr = 'Không tạo được ảnh', flagged = false;
  for (const source of sources) {
    log(`Tạo ảnh ${kind} cho ${storyId} — nguồn: ${source}...`);
    let gen;
    try { gen = await genOne(source, prompt, kind, cfg, log); }
    catch (e) { gen = { ok: false, error: source + ' lỗi: ' + e.message }; }

    if (gen && gen.ok) {
      const key = `${String(storyId).toLowerCase()}-${kind}.jpg`;
      const up = await imageGen.uploadToR2({
        endpoint: cfg.r2Endpoint, accessKeyId: cfg.r2AccessKeyId, secretAccessKey: cfg.r2SecretAccessKey,
        bucket: cfg.r2Bucket, key, body: gen.buffer, contentType: gen.mimeType || 'image/jpeg',
      }, logger);
      if (!up.ok) { log(`✗ R2 up lỗi: ${up.error}`); return { ok: false, error: 'R2: ' + up.error }; }
      const url = String(cfg.r2PublicDomain).replace(/\/+$/, '') + '/' + key;
      circuitRecord(cb, source, true);   // ra anh -> reset chuoi fail cua nguon nay
      log(`✓ Ảnh ${kind} [nguồn ${source}]: ${url}`);
      return { ok: true, url, source };
    }

    // R2/skip (cloudflare chua cau hinh) KHONG tinh la nguon fail (khong ngat cau dao).
    if (gen && gen.skip) { log(`↷ bỏ qua ${source}: ${gen.error}`); continue; }

    // Cac loai fail that (loi/quota/flagged) -> ghi cau dao.
    const nowCut = circuitRecord(cb, source, false);
    if (gen && gen.flagged) { flagged = true; lastErr = gen.error; log(`⊘ ${source} từ chối (bộ lọc) — thử nguồn kế...`); }
    else if (gen && gen.quota) { lastErr = gen.error; log(`⚠️ ${source} hết quota — chuyển nguồn kế...`); }
    else { lastErr = (gen && gen.error) || 'lỗi'; log(`✗ ${source}: ${lastErr} — thử nguồn kế...`); }
    if (nowCut) log(`🔌 Cầu dao: "${source}" fail ${cb.threshold} lần liên tiếp → BỎ nguồn này cho các ảnh còn lại của bài (bài sau thử lại).`);
  }
  return { ok: false, error: lastErr, flagged };
}

module.exports = {
  createAndUpload, orderedSources, DEFAULT_ORDER, DEFAULT_ENABLED,
  makeCircuit, circuitAllows, circuitRecord,
};
