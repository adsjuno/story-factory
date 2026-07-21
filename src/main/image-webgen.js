'use strict';

/**
 * TAO ANH MIEN PHI bang cach DIEU KHIEN CUA SO WEB (Gemini / ChatGPT), KHONG dung API.
 *
 * Tach RIENG hoan toan khoi webai-electron.js (dieu khien Claude viet truyen) - KHONG
 * import, KHONG dung chung code, chi mo cua so/partition rieng cho anh. Dung chung
 * PARTITION dang nhap voi provider tuong ung (persist:gemini / persist:chatgpt) de user
 * chi can dang nhap 1 lan (qua nut "Dang nhap" trong Cai dat, dung IPC settings:aiLogin).
 *
 * Luong: mo cua so -> dan prompt anh -> cho anh render -> lay bytes anh (fetch trong
 * trang -> dataURL) -> tra Buffer cho ben goi (roi ben goi up R2).
 *
 * Vi giao dien Gemini/ChatGPT HAY DOI: selector + cau nhan dien de o CAU HINH ben duoi,
 * va LOG rat ky de khi chay that co the chinh nhanh (xem man Log trong app).
 */

const { BrowserWindow } = require('electron');

const PROVIDERS = {
  gemini: {
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    partition: 'persist:gemini',
    composer: 'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"]',
    sendButton: 'button[aria-label="Send message"], button.send-button, button[aria-label="Gửi"], button[mattooltip="Send message"]',
    stopButton: 'button[aria-label="Stop response"], button[aria-label="Stop generating"], button.stop',
    // Anh Gemini sinh ra thuong nam trong response, src googleusercontent hoac blob
    imageSelectors: 'single-image img, generated-image img, image-container img, message-content img, response-container img, img',
    // Cau bao HET QUOTA / bi gioi han (chuyen sang ChatGPT)
    quotaPhrases: ["you've reached your limit", 'you have reached your limit', 'try again later',
      'daily limit', 'come back later', 'upgrade to', 'limit for', 'quota'],
    // Cau TU CHOI tao anh (bo loc noi dung)
    refusePhrases: ["i can't create", "i'm unable to create", 'i cannot create', 'unable to generate',
      "can't generate that image", 'against', 'policy', 'not able to help with that image',
      "i can't help with that", 'violates'],
    wrap: (p) => 'Generate a single image. Do not add any text explanation. Image prompt: ' + p,
  },
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    partition: 'persist:chatgpt',
    composer: '#prompt-textarea, textarea#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"]',
    sendButton: 'button[data-testid="send-button"], #composer-submit-button, button[data-testid="composer-submit-button"], button[aria-label="Send prompt"]',
    stopButton: 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], #composer-stop-button, button[aria-label="Stop generating"]',
    imageSelectors: '[data-message-author-role="assistant"] img, img[src*="oaiusercontent"], img[alt*="Generated"], figure img, img',
    quotaPhrases: ["you've reached", 'reached your limit', 'try again later', 'usage limit',
      'come back later', 'upgrade to', 'image generation limit', 'rate limit'],
    refusePhrases: ["i can't create", "i'm unable", 'i cannot create', 'unable to generate',
      "can't generate that image", 'content policy', 'against', 'policy', 'violates',
      "i won't be able to"],
    wrap: (p) => 'Create an image (no extra text). ' + p,
  },
};

function cfgOf(provider) { return PROVIDERS[provider]; }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeWindow(partition, show) {
  return new BrowserWindow({
    width: 1200, height: 900, show: !!show,
    title: 'Tạo ảnh (điều khiển web)',
    webPreferences: { partition, backgroundThrottling: false, sandbox: true },
  });
}
async function jsEval(wc, code) { try { return await wc.executeJavaScript(code, true); } catch (_) { return null; } }

async function waitForComposer(wc, composer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await jsEval(wc, `!!document.querySelector(${JSON.stringify(composer)})`)) return true;
    await delay(400);
  }
  return false;
}

// Dan prompt vao o nhap + gui (giong cach webai lam, an voi ProseMirror/contenteditable)
async function typeAndSend(wc, cfg, prompt, log) {
  await jsEval(wc, `(function(){
    var el = document.querySelector(${JSON.stringify(cfg.composer)});
    if (!el) return false;
    el.focus();
    try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch(_){}
    try { return document.execCommand('insertText', false, ${JSON.stringify(prompt)}); } catch(_){ return false; }
  })()`);
  await delay(600);
  let len = await jsEval(wc, `(function(){var e=document.querySelector(${JSON.stringify(cfg.composer)}); return e?(e.innerText||e.value||'').trim().length:-1;})()`);
  if (len < 20) { // du phong: go qua Electron
    await jsEval(wc, `(function(){var e=document.querySelector(${JSON.stringify(cfg.composer)}); if(e)e.focus();})()`);
    await delay(300);
    wc.insertText(prompt);
    await delay(700);
    len = await jsEval(wc, `(function(){var e=document.querySelector(${JSON.stringify(cfg.composer)}); return e?(e.innerText||e.value||'').trim().length:-1;})()`);
  }
  if (len < 20) return { ok: false, error: 'Không gõ được prompt vào ' + cfg.name + ' (giao diện web có thể vừa đổi).' };

  // Gui: bam nut send; neu khong duoc thi Enter
  const clicked = await jsEval(wc, `(function(){var b=document.querySelector(${JSON.stringify(cfg.sendButton)}); if(b&&!b.disabled){b.click(); return true;} return false;})()`);
  await delay(1000);
  if (!clicked) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await delay(1000);
  }
  return { ok: true };
}

// Lay text tra loi gan nhat (de nhan dien het quota / tu choi)
async function lastText(wc) {
  return (await jsEval(wc, `(function(){
    var sels=['[data-message-author-role="assistant"]','message-content','.model-response-text','div.markdown','.response-container-content'];
    for(var i=0;i<sels.length;i++){var a=document.querySelectorAll(sels[i]); if(a.length) return (a[a.length-1].innerText||'').slice(0,4000);}
    return (document.body.innerText||'').slice(-4000);
  })()`)) || '';
}

// Tim URL anh sinh ra (lon, khong phai icon). Tra ve src hoac ''
async function findImageSrc(wc, cfg) {
  return (await jsEval(wc, `(function(){
    var imgs = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(cfg.imageSelectors)}));
    var best=''; var bestArea=0;
    for (var i=imgs.length-1;i>=0;i--){
      var im=imgs[i]; var s=im.currentSrc||im.src||'';
      if(!s) continue;
      if(s.indexOf('data:image/svg')===0) continue;         // bo icon svg
      var w=im.naturalWidth||im.width||0, h=im.naturalHeight||im.height||0;
      if(w<256||h<256) continue;                            // bo anh nho (avatar/icon)
      var area=w*h;
      if(area>bestArea){bestArea=area; best=s;}
    }
    return best;
  })()`)) || '';
}

// Tai bytes anh NGAY TRONG trang (fetch cung origin/CDN cua ho) -> dataURL
async function fetchImageDataUrl(wc, src) {
  const code = `(async function(){
    try {
      var r = await fetch(${JSON.stringify(src)});
      var b = await r.blob();
      return await new Promise(function(res){ var fr=new FileReader(); fr.onerror=function(){res('');}; fr.onload=function(){res(fr.result);}; fr.readAsDataURL(b); });
    } catch(e) {
      // du phong: ve canvas (chi duoc neu anh khong bi taint CORS)
      try {
        var im=new Image(); im.crossOrigin='anonymous';
        return await new Promise(function(res){ im.onload=function(){ try{var c=document.createElement('canvas'); c.width=im.naturalWidth; c.height=im.naturalHeight; c.getContext('2d').drawImage(im,0,0); res(c.toDataURL('image/jpeg',0.92)); }catch(_){res('');} }; im.onerror=function(){res('');}; im.src=${JSON.stringify(src)}; });
      } catch(_) { return ''; }
    }
  })()`;
  return (await jsEval(wc, code)) || '';
}

function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
  if (!m) return null;
  return { mimeType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

function hasAny(text, phrases) {
  const t = String(text || '').toLowerCase();
  return phrases.some((p) => t.includes(p));
}

/**
 * Tao 1 anh qua dieu khien cua so.
 * @returns {ok:true, buffer, mimeType} | {ok:false, error, quota?, flagged?}
 */
async function generate(provider, prompt, { timeoutMs = 180000, show = false, log = () => {} } = {}) {
  const cfg = cfgOf(provider);
  if (!cfg) return { ok: false, error: 'Nguồn ảnh không hỗ trợ: ' + provider };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'Prompt ảnh rỗng' };

  const win = makeWindow(cfg.partition, show);
  const wc = win.webContents;
  try {
    log(`[${cfg.name}] mở cửa sổ, tải trang...`);
    await win.loadURL(cfg.url).catch(() => {});
    if (!(await waitForComposer(wc, cfg.composer, 25000))) {
      return { ok: false, error: 'Chưa đăng nhập ' + cfg.name + ' (không thấy ô nhập). Vào Cài đặt → "Đăng nhập ' + cfg.name + '".' };
    }
    log(`[${cfg.name}] gõ prompt & gửi...`);
    const sent = await typeAndSend(wc, cfg, cfg.wrap(String(prompt)), log);
    if (!sent.ok) return { ok: false, error: sent.error };

    // Cho anh render: kiem tra dinh ky co anh chua; song song soi text tu choi/het quota
    const deadline = Date.now() + timeoutMs;
    let src = '';
    while (Date.now() < deadline) {
      await delay(2500);
      src = await findImageSrc(wc, cfg);
      if (src) break;
      const txt = await lastText(wc);
      if (hasAny(txt, cfg.refusePhrases)) {
        log(`[${cfg.name}] ⊘ bị từ chối tạo ảnh (bộ lọc nội dung).`);
        return { ok: false, flagged: true, error: cfg.name + ' từ chối tạo ảnh (bộ lọc nội dung).' };
      }
      if (hasAny(txt, cfg.quotaPhrases)) {
        log(`[${cfg.name}] ⚠️ báo hết quota/giới hạn.`);
        return { ok: false, quota: true, error: cfg.name + ' hết quota/giới hạn ngày.' };
      }
    }
    if (!src) return { ok: false, error: cfg.name + ' không thấy ảnh sau ' + Math.round(timeoutMs / 1000) + 's (giao diện có thể đổi, hoặc chưa render).' };

    log(`[${cfg.name}] tìm thấy ảnh, đang tải bytes...`);
    const dataUrl = await fetchImageDataUrl(wc, src);
    const got = dataUrlToBuffer(dataUrl);
    if (!got || !got.buffer.length) return { ok: false, error: 'Không lấy được bytes ảnh từ ' + cfg.name + ' (CORS/định dạng).' };

    log(`[${cfg.name}] ✓ lấy ảnh ${Math.round(got.buffer.length / 1024)}KB (${got.mimeType}).`);
    return { ok: true, buffer: got.buffer, mimeType: got.mimeType };
  } catch (e) {
    return { ok: false, error: cfg.name + ' lỗi: ' + e.message };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

module.exports = { generate, PROVIDERS };
