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
    // Dau hieu "DANG TAO ANH": src placeholder 150x150 gstatic/lamda (animation cua Gemini).
    // Con thay dau hieu nay = Gemini van dang ve -> cho tiep (khong cat o mốc cứng).
    genPlaceholder: ['gstatic.com/lamda', 'lamda/images/gemini'],
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
    // ChatGPT khong co placeholder src co dinh -> dua vao nut Stop (isGenerating). Anh tao dan
    // (progressive) da duoc status 'pending' xu ly.
    genPlaceholder: [],
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

/**
 * TRICH BYTES anh NGAY TRONG trang, thu LAN LUOT nhieu cach - cach nao duoc thi dung:
 *   data-url        : the <img> src la data:image/... -> lay thang.
 *   existing-canvas : ve <img> DA LOAD (naturalWidth>0) len canvas (khong goi mang;
 *                     duoc neu anh khong bi taint CORS) -> ho tro ca webp -> jpeg.
 *   fetch-blob      : fetch(src) -> blob -> dataURL (blob:/same-origin/CORS cho phep).
 *   anon-canvas     : tao Image moi crossOrigin=anonymous -> canvas (CDN co CORS header).
 * Tra: {status:'ok',dataUrl,method,mime} | {status:'pending'} (anh chua load xong)
 *      | {status:'none'} (chua co anh) | {status:'fail'} (co anh nhung moi cach deu fail)
 */
async function extractBestImage(wc, cfg) {
  const code = `(async function(){
    function pick(){
      var imgs=Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(cfg.imageSelectors)}));
      var best=null,area=0;
      for(var i=imgs.length-1;i>=0;i--){
        var im=imgs[i]; var s=im.currentSrc||im.src||'';
        if(!s) continue;
        if(s.indexOf('data:image/svg')===0) continue;
        var w=im.naturalWidth||0,h=im.naturalHeight||0, dw=im.width||0,dh=im.height||0;
        if((w<256||h<256)&&(dw<256||dh<256)) continue;   // bo icon/avatar nho
        var ar=(w*h)||(dw*dh);
        if(ar>area){area=ar; best=im;}
      }
      return best;
    }
    function toJpeg(cv){ try{return cv.toDataURL('image/jpeg',0.92);}catch(e){return '';} }
    var img=pick();
    if(!img) return {status:'none'};
    var s=img.currentSrc||img.src||'';
    // 0) data: URL -> lay thang (ho tro moi dinh dang gom webp)
    if(s.indexOf('data:image/')===0) return {status:'ok',dataUrl:s,method:'data-url'};
    // neu the img chua load xong -> bao pending de vong ngoai cho + thu lai
    if(!(img.naturalWidth>0 && img.complete) && s.indexOf('blob:')!==0) return {status:'pending'};
    // 1) canvas tu img DA LOAD (khong goi mang) - webp cung ve duoc
    try{ if(img.naturalWidth>0){ var c=document.createElement('canvas'); c.width=img.naturalWidth;c.height=img.naturalHeight; c.getContext('2d').drawImage(img,0,0); var d1=toJpeg(c); if(d1) return {status:'ok',dataUrl:d1,method:'existing-canvas'}; } }catch(e){}
    // 2) fetch blob (blob:/same-origin/CORS-ok) - giu nguyen mime (jpeg/png/webp)
    try{ var r=await fetch(s,{cache:'force-cache'}); if(r.ok){ var b=await r.blob(); var d2=await new Promise(function(res){var fr=new FileReader();fr.onerror=function(){res('');};fr.onload=function(){res(fr.result);};fr.readAsDataURL(b);}); if(d2&&d2.indexOf('data:image')===0) return {status:'ok',dataUrl:d2,method:'fetch-blob',mime:b.type||''}; } }catch(e){}
    // 3) anh moi crossOrigin anonymous -> canvas (CDN co CORS header)
    try{ var d3=await new Promise(function(res){ var im=new Image(); im.crossOrigin='anonymous'; im.onload=function(){ try{var c2=document.createElement('canvas');c2.width=im.naturalWidth;c2.height=im.naturalHeight;c2.getContext('2d').drawImage(im,0,0);res(toJpeg(c2));}catch(_){res('');} }; im.onerror=function(){res('');}; im.src=s; }); if(d3) return {status:'ok',dataUrl:d3,method:'anon-canvas'}; }catch(e){}
    return {status:'fail'};
  })()`;
  return (await jsEval(wc, code)) || { status: 'none' };
}

// CHAN DOAN: khi khong tim thay anh, dump thuc te DOM co GI (moi img + kich thuoc + src prefix,
// va co background-image lon nao khong). Giup lan chay that lo ra Gemini dat anh o dau.
async function domImageDiag(wc) {
  const code = `(function(){
    var out={imgs:[],bg:0,iframes:0,shadow:0};
    var all=document.querySelectorAll('img');
    out.imgTotal=all.length;
    for(var i=0;i<all.length;i++){var im=all[i];var s=im.currentSrc||im.src||'';
      out.imgs.push({w:im.naturalWidth||0,h:im.naturalHeight||0,dw:im.width||0,dh:im.height||0,src:s.slice(0,42)});}
    // giu lai 8 anh LON nhat de log gon
    out.imgs.sort(function(a,b){return (b.w*b.h)-(a.w*a.h);}); out.imgs=out.imgs.slice(0,8);
    // background-image lon (anh render dang CSS bg)
    var els=document.querySelectorAll('*');
    for(var j=0;j<els.length;j++){var bg=getComputedStyle(els[j]).backgroundImage;
      if(bg&&bg.indexOf('url(')===0&&els[j].offsetWidth>=256&&els[j].offsetHeight>=256)out.bg++;}
    out.iframes=document.querySelectorAll('iframe').length;
    // dem host co shadowRoot (querySelectorAll khong xuyen qua)
    for(var k=0;k<els.length;k++){ if(els[k].shadowRoot) out.shadow++; }
    return out;
  })()`;
  return (await jsEval(wc, code)) || null;
}

function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
  if (!m) return null;
  return { mimeType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

// LOGIC THUAN (test duoc, khong can DOM): con dang tao khong?
//  nut Stop hien -> co. HOAC 1 img co src chua dau hieu placeholder "dang tao" (vd gstatic/lamda).
function detectGenerating(hasStop, srcs, marks) {
  if (hasStop) return true;
  if (marks && marks.length && Array.isArray(srcs)) {
    for (const s of srcs) { const str = String(s || ''); for (const m of marks) if (str.indexOf(m) >= 0) return true; }
  }
  return false;
}
// LOGIC THUAN: nen cho tiep hay bo? 'continue' | 'giveup-idle' (tac) | 'giveup-hardcap' (qua tran).
function waitVerdict({ generating, hasImageSignal, idleElapsed, idleMs, totalElapsed, hardCapMs }) {
  if (totalElapsed > hardCapMs) return 'giveup-hardcap';
  if (!generating && !hasImageSignal && idleElapsed > idleMs) return 'giveup-idle';
  return 'continue';
}

// DANG TAO ANH? (tin hieu THAT, khong doi dong ho). Query DOM lay {hasStop, srcs} roi cham thuan.
async function isGenerating(wc, cfg) {
  const sig = await jsEval(wc, `(function(){
    var hasStop=false; try{ hasStop=!!document.querySelector(${JSON.stringify(cfg.stopButton)}); }catch(_){}
    var srcs=[]; var imgs=document.querySelectorAll('img');
    for(var i=0;i<imgs.length && srcs.length<12;i++){ srcs.push(imgs[i].currentSrc||imgs[i].src||''); }
    return {hasStop:hasStop, srcs:srcs};
  })()`) || { hasStop: false, srcs: [] };
  return detectGenerating(sig.hasStop, sig.srcs, cfg.genPlaceholder || []);
}

function hasAny(text, phrases) {
  const t = String(text || '').toLowerCase();
  return phrases.some((p) => t.includes(p));
}

/**
 * Tao 1 anh qua dieu khien cua so.
 * @returns {ok:true, buffer, mimeType} | {ok:false, error, quota?, flagged?}
 */
// hardCapMs: tran TUYET DOI khi Gemini con dang tao (mac dinh 150s).
// idleMs: khong tin hieu dang-tao + khong anh + khong text lien tuc qua nguong nay -> TAC that -> bo som.
async function generate(provider, prompt, { hardCapMs = 150000, idleMs = 20000, show = false, log = () => {} } = {}) {
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

    // ---- CHO THONG MINH (do TIN HIEU, khong do dong ho) ----
    //  - Con tin hieu "dang tao" (nut Stop / placeholder gstatic) -> cho tiep, toi tran hardCap 150s.
    //  - Khong tin hieu + khong anh + khong text lien tuc qua idleMs (20s) -> TAC that -> bo som.
    //  - Co text tu choi/het quota -> bo NGAY.
    const start = Date.now();
    let lastProgress = start;  // lan cuoi thay TIEN TRIEN (dang-tao HOAC co the <img>)
    let sawImage = false, failStreak = 0, lastDiag = 0;
    while (true) {
      const now = Date.now();
      if (now - start > hardCapMs) {
        return { ok: false, error: cfg.name + ' quá ' + Math.round(hardCapMs / 1000) + 's vẫn chưa ra ảnh — dừng (fallback lo phần còn lại).' };
      }
      const ex = await extractBestImage(wc, cfg);

      if (ex.status === 'ok') {
        const got = dataUrlToBuffer(ex.dataUrl);
        if (got && got.buffer.length) {
          log(`[${cfg.name}] ✓ lấy ảnh ${Math.round(got.buffer.length / 1024)}KB (${got.mimeType}) bằng: ${ex.method}${ex.mime ? ' [' + ex.mime + ']' : ''} (sau ${Math.round((now - start) / 1000)}s).`);
          return { ok: true, buffer: got.buffer, mimeType: got.mimeType };
        }
        sawImage = true; failStreak++; lastProgress = now;
      } else if (ex.status === 'pending') {
        sawImage = true; failStreak = 0; lastProgress = now;
        log(`[${cfg.name}] ảnh đang tải, chờ thêm...`);
      } else if (ex.status === 'fail') {
        sawImage = true; failStreak++; lastProgress = now;
        log(`[${cfg.name}] có ảnh nhưng trích bytes chưa được (thử lại ${failStreak}/4)...`);
        if (failStreak >= 4) {
          return { ok: false, error: 'Không lấy được bytes ảnh từ ' + cfg.name + ' sau khi thử mọi cách (CORS/định dạng).' };
        }
      } else {
        // chua co anh -> soi text tu choi / het quota TRUOC
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

      // TIN HIEU DANG TAO (nut Stop / placeholder). Con thay = tien trien -> reset dong ho idle.
      const generating = await isGenerating(wc, cfg);
      if (generating) lastProgress = now;
      const hasImageSignal = ex.status !== 'none';   // co the <img> (dang tai/trich) = co tien trien

      // CHAN DOAN ~10s/lan (kem trang thai generating de doc log ro nguyen nhan)
      if (now - lastDiag > 10000) {
        lastDiag = now;
        const d = await domImageDiag(wc);
        if (d) {
          const top = (d.imgs || []).slice(0, 3).map((x) => `${x.w}x${x.h}(${x.src})`).join(' , ');
          log(`[${cfg.name}] 🔍 DOM: ${d.imgTotal} <img> (lớn nhất: ${top || 'không có'}) | đang-tạo: ${generating ? 'CÓ (chờ tiếp)' : 'không'} | idle ${Math.round((now - lastProgress) / 1000)}s | ${Math.round((now - start) / 1000)}s`);
        }
      }

      // QUYET DINH cho/bo bang LOGIC THUAN (test duoc).
      const verdict = waitVerdict({ generating, hasImageSignal, idleElapsed: now - lastProgress, idleMs, totalElapsed: now - start, hardCapMs });
      if (verdict === 'giveup-idle') {
        return { ok: false, error: cfg.name + ' không có tín hiệu đang tạo suốt ' + Math.round((now - lastProgress) / 1000) + 's (tắc) — bỏ sớm, thử nguồn kế.' };
      }
      // giveup-hardcap da duoc chan o dau vong (now-start>hardCapMs); con lai -> continue.
      await delay(1800); // cho 1.8s roi thu lai (retry)
    }
  } catch (e) {
    return { ok: false, error: cfg.name + ' lỗi: ' + e.message };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

module.exports = { generate, PROVIDERS, dataUrlToBuffer, detectGenerating, waitVerdict };
