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
    // CUM tu MODEL that tu choi. BO 'against'/'policy' tran trui (qua rong -> tung bao nham).
    refusePhrases: ["i can't create", "i'm unable to create", 'i cannot create', 'unable to generate',
      "can't generate that image", 'content policy', 'not able to help with that image',
      "i can't help with that", 'violates our', 'against our'],
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
    // BO 'against'/'policy' tran trui (qua rong -> tung bao nham tu dong 'Privacy Policy' cua trang).
    refusePhrases: ["i can't create", "i'm unable", 'i cannot create', 'unable to generate',
      "can't generate that image", 'content policy', 'violates our', 'against our',
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

// BAN su kien input/beforeinput de framework (Angular/Quill cua Gemini, ProseMirror cua ChatGPT)
// GHI NHAN text vua chen. KHONG lam viec nay -> nut Gui KHONG BAT -> gui truot -> chat trong.
// (Da kiem chung tren Gemini live: execCommand chen text OK nhung nut "Send message" chi hien
//  sau khi ban 'input'/'beforeinput'.)
async function fireInputEvents(wc, composer) {
  await jsEval(wc, `(function(){
    var el=document.querySelector(${JSON.stringify(composer)}); if(!el) return false; el.focus();
    try{ el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:' '})); }catch(_){}
    try{ el.dispatchEvent(new InputEvent('input',{bubbles:true,cancelable:true,inputType:'insertText'})); }catch(_){}
    try{ el.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){}
    try{ el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'a'})); el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'a'})); }catch(_){}
    return true;
  })()`);
}
// Doi NUT GUI xuat hien & enabled (nut chi hien sau khi framework ghi nhan text). Tra selector khop hay false.
async function waitSendButton(wc, sendSel, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    const ok = await jsEval(wc, `(function(){var b=document.querySelector(${JSON.stringify(sendSel)}); return !!(b && !b.disabled && b.offsetParent!==null);})()`);
    if (ok) return true;
    await delay(300);
  }
  return false;
}
async function boxLen(wc, composer) {
  return await jsEval(wc, `(function(){var e=document.querySelector(${JSON.stringify(composer)}); return e?((e.innerText||e.value||'')+'').trim().length:-1;})()`);
}

// Dan prompt vao o nhap + gui, CO VERIFY BAT BUOC (khong bao ao). Tra:
//  {ok:true} | {ok:false, notSent:true, error} (KHONG bao gio la "bi loc").
async function typeAndSend(wc, cfg, prompt, log) {
  // 1) CHEN text
  await jsEval(wc, `(function(){
    var el = document.querySelector(${JSON.stringify(cfg.composer)});
    if (!el) return false;
    el.focus();
    try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch(_){}
    try { return document.execCommand('insertText', false, ${JSON.stringify(prompt)}); } catch(_){ return false; }
  })()`);
  await delay(400);
  await fireInputEvents(wc, cfg.composer);   // <-- MAU CHOT: bao framework "co text moi"
  await delay(300);
  let len = await boxLen(wc, cfg.composer);
  if (len < 20) { // du phong: go qua Electron (go that -> tu ban input event)
    await jsEval(wc, `(function(){var e=document.querySelector(${JSON.stringify(cfg.composer)}); if(e)e.focus();})()`);
    await delay(300);
    wc.insertText(prompt);
    await delay(700);
    await fireInputEvents(wc, cfg.composer);
    await delay(300);
    len = await boxLen(wc, cfg.composer);
  }
  // VERIFY 1: prompt DA VAO O chua? Trong -> bao KHONG GO DUOC (KHONG phai "bi loc").
  if (len < 20) {
    const dc = await diagComposer(wc, cfg);
    if (dc) log(`[${cfg.name}] 🔬 Ô NHẬP: ${dc.box ? ('<' + dc.box.tag + '> aria="' + dc.box.aria + '"') : 'KHÔNG THẤY'} | selector khớp: ${(dc.boxSelMatched && dc.boxSelMatched.length) ? dc.boxSelMatched.join(' ; ') : '❌ KHÔNG CÁI NÀO'}`);
    return { ok: false, notSent: true, error: 'KHÔNG GÕ ĐƯỢC PROMPT vào ' + cfg.name + ' (ô nhập trống sau khi gõ — selector ô nhập có thể đã đổi).' };
  }

  // 2) GUI: doi nut gui XUAT HIEN roi bam; khong co thi Enter.
  const trySend = async () => {
    const ready = await waitSendButton(wc, cfg.sendButton, 4000);
    let clicked = false;
    if (ready) clicked = await jsEval(wc, `(function(){var b=document.querySelector(${JSON.stringify(cfg.sendButton)}); if(b&&!b.disabled){b.click(); return true;} return false;})()`);
    if (!clicked) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
    return { ready, clicked };
  };
  const s1 = await trySend();
  await delay(1600);

  // VERIFY 2: DA GUI THAT chua? o nhap rong lai HOAC co luot NGUOI DUNG moi trong DOM.
  let sent = await diagSent(wc, cfg);
  if (!(sent.userTurns > 0 || sent.boxLen === 0)) {
    log(`[${cfg.name}] ⟳ chưa thấy chat mới (nút gửi ready=${s1.ready}, click=${s1.clicked}) — bắn lại input & gửi lần 2...`);
    await fireInputEvents(wc, cfg.composer);
    await delay(300);
    await trySend();
    await delay(1800);
    sent = await diagSent(wc, cfg);
    if (!(sent.userTurns > 0 || sent.boxLen === 0)) {
      const dc = await diagComposer(wc, cfg);
      if (dc) log(`[${cfg.name}] 🔬 NÚT GỬI: ${dc.sendFound ? ('CÓ aria="' + dc.sendAria + '" disabled=' + dc.sendDisabled) : 'KHÔNG THẤY'} | selector khớp: ${(dc.sendSelMatched && dc.sendSelMatched.length) ? dc.sendSelMatched.join(' ; ') : '❌ KHÔNG CÁI NÀO'}`);
      return { ok: false, notSent: true, error: 'ĐÃ GÕ ĐƯỢC PROMPT NHƯNG KHÔNG GỬI ĐƯỢC vào ' + cfg.name + ' (nút gửi/Enter không kích hoạt — selector nút gửi có thể đã đổi).' };
    }
  }
  log(`[${cfg.name}] ✅ đã gửi prompt (ô nhập còn ${sent.boxLen} ký tự, lượt người dùng=${sent.userTurns}).`);
  return { ok: true };
}

// Lay text tra loi gan nhat + NGUON lay tu dau.
//  src='assistant' -> LA loi MODEL that (ket luan tu choi tu day moi dang tin).
//  src='body'      -> CHI la chu tren trang (chrome/UI) - ket luan "tu choi" tu day co the BIA,
//                     vi body co san 'policy'/'terms'/'against' du model KHONG he tu choi.
async function lastTextSrc(wc) {
  return (await jsEval(wc, `(function(){
    var sels=['[data-message-author-role="assistant"]','message-content','.model-response-text','div.markdown','.response-container-content'];
    for(var i=0;i<sels.length;i++){var a=document.querySelectorAll(sels[i]); if(a.length) return {text:(a[a.length-1].innerText||'').slice(0,4000), src:'assistant'};}
    return {text:(document.body.innerText||'').slice(-4000), src:'body'};
  })()`)) || { text: '', src: 'none' };
}
async function lastText(wc) { return (await lastTextSrc(wc)).text; }

// LOGIC THUAN (test duoc): cum tu dau tien khop + vi tri (de log dan chung "tu choi").
function firstMatch(text, phrases) {
  const t = String(text || '').toLowerCase();
  for (const p of (phrases || [])) { const i = t.indexOf(String(p).toLowerCase()); if (i >= 0) return { phrase: p, idx: i }; }
  return null;
}

// CHAN DOAN GUI: mo ta O NHAP + NUT GUI HIEN TAI + selector nao con khop (biet giao dien co doi khong).
async function diagComposer(wc, cfg) {
  return await jsEval(wc, `(function(){
    function d(el){ if(!el) return null; return {tag:(el.tagName||'').toLowerCase(), aria:(el.getAttribute&&el.getAttribute('aria-label'))||'', ph:(el.getAttribute&&(el.getAttribute('data-placeholder')||el.getAttribute('placeholder')))||'', len:((el.innerText||el.value||'')+'').trim().length}; }
    function matched(sel){ var out=[]; var parts=sel.split(','); for(var i=0;i<parts.length;i++){ var p=parts[i].trim(); try{ if(p && document.querySelector(p)) out.push(p); }catch(_){}} return out; }
    var el=document.querySelector(${JSON.stringify(cfg.composer)});
    var sb=document.querySelector(${JSON.stringify(cfg.sendButton)});
    return { box:d(el), boxSelMatched:matched(${JSON.stringify(cfg.composer)}),
             sendFound:!!sb, sendSelMatched:matched(${JSON.stringify(cfg.sendButton)}),
             sendDisabled: sb?!!sb.disabled:null, sendAria: sb?((sb.getAttribute('aria-label'))||''):'' };
  })()`) || null;
}
// CHAN DOAN DA GUI CHUA: o nhap da rong lai chua + co luot NGUOI DUNG moi trong DOM khong.
async function diagSent(wc, cfg) {
  return await jsEval(wc, `(function(){
    var el=document.querySelector(${JSON.stringify(cfg.composer)});
    var boxLen = el?((el.innerText||el.value||'')+'').trim().length:-1;
    var userSel=['[data-message-author-role="user"]','user-query','.query-text','.user-query-bubble-with-background','[data-testid="conversation-turn"] [data-message-author-role="user"]'];
    var userTurns=0; for(var i=0;i<userSel.length;i++){ try{ userTurns+=document.querySelectorAll(userSel[i]).length; }catch(_){}}
    return {boxLen:boxLen, userTurns:userTurns};
  })()`) || { boxLen: -1, userTurns: 0 };
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
async function domImageDiag(wc, marks) {
  const code = `(function(){
    var marks=${JSON.stringify(marks || [])};
    var out={imgs:[],bg:0,iframes:0,shadow:0,ph:[]};
    var all=document.querySelectorAll('img');
    out.imgTotal=all.length;
    // PHAN LOAI placeholder "dang tao": nam trong RESPONSE that (assistant) hay chi la UI trang tri?
    for(var pi=0; pi<all.length && out.ph.length<3; pi++){
      var pim=all[pi]; var ps=(pim.currentSrc||pim.src||''); var hit=false;
      for(var mi=0;mi<marks.length;mi++){ if(ps.indexOf(marks[mi])>=0){hit=true;break;} }
      if(!hit) continue;
      var p=pim, chain=[], inResp=false;
      for(var up=0; up<5 && p; up++){ p=p.parentElement; if(!p)break;
        var role=p.getAttribute&&p.getAttribute('data-message-author-role');
        var tn=(p.tagName||'').toLowerCase();
        if(role==='assistant'||/response|message-content|model-response/.test(tn)||/response|model-response/.test((p.className||'')+'')) inResp=true;
        chain.push(tn+(role?('['+role+']'):''));
      }
      out.ph.push({w:pim.naturalWidth||pim.width||0, inResp:inResp, parent:chain.join('>')});
    }
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

// LOGIC THUAN (test duoc): 1 img co src chua dau hieu placeholder "dang tao" (gstatic/lamda) khong?
function placeholderPresent(srcs, marks) {
  if (marks && marks.length && Array.isArray(srcs)) {
    for (const s of srcs) { const str = String(s || ''); for (const m of marks) if (str.indexOf(m) >= 0) return true; }
  }
  return false;
}
// (giu tuong thich): con dang tao khong? nut Stop HOAC placeholder.
function detectGenerating(hasStop, srcs, marks) {
  return !!hasStop || placeholderPresent(srcs, marks);
}
// LOGIC THUAN: nen cho tiep hay bo? PHAN BIET 2 loai tin hieu "dang tao":
//   - hasStop=true  = nut Stop con hien = DANG TAO THAT (ChatGPT/Gemini that su lam viec)
//                     -> KIEN NHAN toi hardCap 150s, KHONG cat o 70s (khong giet oan anh cham).
//   - hasPlaceholder (gstatic/lamda) NHUNG khong Stop = tin hieu GIA (animation trang tri)
//                     -> neu dung im qua stuckCapMs (70s) va chua co anh that -> KET GIA -> bo som.
//   - hasImageSignal=true = co the <img> THAT (>=256, dang render dan) -> cho toi hardCap.
// Tra: 'continue' | 'giveup-idle' (tac) | 'giveup-stuck' (placeholder gia dung im) | 'giveup-hardcap'.
function waitVerdict({ hasStop, hasPlaceholder, hasImageSignal, idleElapsed, idleMs, totalElapsed, hardCapMs, absMaxMs = Infinity, genOnlyElapsed = 0, stuckCapMs = Infinity }) {
  if (totalElapsed > absMaxMs) return 'giveup-hardcap';                 // tran tuyet doi (du con Stop)
  // SOFT-CAP: qua 150s MA khong con lam viec that (khong Stop) + chua co anh -> bo.
  //  (Con nut Stop = van dang tao -> KHONG bo o 150s, cho toi absMax -> khong mat anh cham do prompt dai.)
  if (totalElapsed > hardCapMs && !hasStop && !hasImageSignal) return 'giveup-hardcap';
  // STUCK chi ap khi placeholder GIA (khong co nut Stop that) + chua co anh that.
  if (!hasStop && hasPlaceholder && !hasImageSignal && genOnlyElapsed > stuckCapMs) return 'giveup-stuck';
  const generating = !!hasStop || !!hasPlaceholder;
  if (!generating && !hasImageSignal && idleElapsed > idleMs) return 'giveup-idle';
  return 'continue';
}

// TIN HIEU DANG TAO tach RIENG: {hasStop (that), hasPlaceholder (gia)}. Query DOM 1 lan.
async function genSignals(wc, cfg) {
  const sig = await jsEval(wc, `(function(){
    var hasStop=false; try{ hasStop=!!document.querySelector(${JSON.stringify(cfg.stopButton)}); }catch(_){}
    var srcs=[]; var imgs=document.querySelectorAll('img');
    for(var i=0;i<imgs.length && srcs.length<12;i++){ srcs.push(imgs[i].currentSrc||imgs[i].src||''); }
    return {hasStop:hasStop, srcs:srcs};
  })()`) || { hasStop: false, srcs: [] };
  return { hasStop: !!sig.hasStop, hasPlaceholder: placeholderPresent(sig.srcs, cfg.genPlaceholder || []) };
}

function hasAny(text, phrases) {
  const t = String(text || '').toLowerCase();
  return phrases.some((p) => t.includes(p));
}

/**
 * Tao 1 anh qua dieu khien cua so.
 * @returns {ok:true, buffer, mimeType} | {ok:false, error, quota?, flagged?}
 */
// hardCapMs: soft-cap - qua nguong nay MA KHONG con nut Stop (het lam viec) + chua co anh -> bo (150s).
// absMaxMs: tran TUYET DOI - du con nut Stop (dang lam viec) cung khong cho qua (300s = 5 phut).
//   -> prompt DAI khien ChatGPT xu ly >150s van cho tiep (con Stop), toi 300s -> khong mat anh cham.
// stuckCapMs: placeholder "dang tao" DUNG IM (chua co anh, khong Stop) qua nguong nay -> ket gia -> bo (70s).
// idleMs: khong tin hieu dang-tao + khong anh + khong text lien tuc qua nguong nay -> TAC that -> bo som.
async function generate(provider, prompt, { hardCapMs = 150000, absMaxMs = 300000, stuckCapMs = 70000, idleMs = 20000, show = false, log = () => {} } = {}) {
  const cfg = cfgOf(provider);
  if (!cfg) return { ok: false, error: 'Nguồn ảnh không hỗ trợ: ' + provider };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'Prompt ảnh rỗng' };

  const win = makeWindow(cfg.partition, show);
  const wc = win.webContents;
  try {
    log(`[${cfg.name}] mở cửa sổ (${show ? 'HIỆN — giám sát' : 'ẨN — chạy ngầm'}), tải trang...`);
    await win.loadURL(cfg.url).catch(() => {});
    if (!(await waitForComposer(wc, cfg.composer, 25000))) {
      return { ok: false, error: 'Chưa đăng nhập ' + cfg.name + ' (không thấy ô nhập). Vào Cài đặt → "Đăng nhập ' + cfg.name + '".' };
    }
    log(`[${cfg.name}] gõ prompt & gửi...`);
    const sent = await typeAndSend(wc, cfg, cfg.wrap(String(prompt)), log);
    if (!sent.ok) return { ok: false, error: sent.error };

    // (typeAndSend da VERIFY gui that + log ket qua; block chan doan selector chi bat khi NGHI loi.)

    // ---- CHO THONG MINH (do TIN HIEU, khong do dong ho) ----
    //  - Con tin hieu "dang tao" (nut Stop / placeholder gstatic) -> cho tiep, toi tran hardCap 150s.
    //  - Khong tin hieu + khong anh + khong text lien tuc qua idleMs (20s) -> TAC that -> bo som.
    //  - Co text tu choi/het quota -> bo NGAY.
    const start = Date.now();
    let lastProgress = start;  // lan cuoi thay TIEN TRIEN (dang-tao HOAC co the <img>)
    let genStart = 0;          // moc bat dau chuoi "dang-tao NHUNG chua co anh that" (placeholder dung im)
    let sawImage = false, failStreak = 0, lastDiag = 0;
    while (true) {
      const now = Date.now();
      if (now - start > absMaxMs) {
        return { ok: false, error: cfg.name + ' quá ' + Math.round(absMaxMs / 1000) + 's (trần tuyệt đối) vẫn chưa ra ảnh — dừng (fallback lo phần còn lại).' };
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
        // chua co anh -> soi text tu choi / het quota. CHI TIN khi text den tu MODEL THAT (assistant),
        // KHONG BAO GIO ket luan "tu choi/quota" tu chu tren trang (body) - vi body co san 'policy'/'terms'
        // -> tranh BAO NHAM "bi loc" (loi cu da xac nhan: 'policy' khop dong 'Privacy Policy' cua trang).
        const lt = await lastTextSrc(wc);
        if (lt.src === 'assistant') {
          const rf = firstMatch(lt.text, cfg.refusePhrases);
          if (rf) {
            const snip = lt.text.slice(Math.max(0, rf.idx - 40), rf.idx + 60).replace(/\s+/g, ' ');
            log(`[${cfg.name}] ⊘ model TỪ CHỐI (khớp "${rf.phrase}") | trích: "…${snip}…"`);
            return { ok: false, flagged: true, error: cfg.name + ' từ chối tạo ảnh (model: "' + rf.phrase + '").' };
          }
          const qf = firstMatch(lt.text, cfg.quotaPhrases);
          if (qf) {
            log(`[${cfg.name}] ⚠️ model báo hết quota (khớp "${qf.phrase}").`);
            return { ok: false, quota: true, error: cfg.name + ' hết quota/giới hạn ngày.' };
          }
        }
        // src='body'/'none': CHUA co loi model -> KHONG ket luan gi, de vong lap cho tiep (idle/stuck se xu ly).
      }

      // TIN HIEU DANG TAO tach rieng: nut Stop (THAT) vs placeholder gstatic (GIA).
      const sig = await genSignals(wc, cfg);
      const generating = sig.hasStop || sig.hasPlaceholder;
      if (generating) lastProgress = now;
      const hasImageSignal = ex.status !== 'none';   // co the <img> THAT (>=256, dang tai/trich) = tien trien that

      // "PLACEHOLDER GIA DUNG IM" CHI tinh khi: co placeholder + KHONG co nut Stop + chua co anh that.
      //  (Con nut Stop = dang tao THAT -> KHONG dem stuck, de hardCap 150s lo -> khong giet oan ChatGPT cham.)
      const stuckEligible = sig.hasPlaceholder && !sig.hasStop && !hasImageSignal;
      if (stuckEligible) { if (!genStart) genStart = now; }
      else { genStart = 0; }
      const genOnlyElapsed = genStart ? now - genStart : 0;

      // CHAN DOAN ~10s/lan (kem trang thai generating de doc log ro nguyen nhan)
      if (now - lastDiag > 10000) {
        lastDiag = now;
        const d = await domImageDiag(wc, cfg.genPlaceholder || []);
        if (d) {
          const top = (d.imgs || []).slice(0, 3).map((x) => `${x.w}x${x.h}(${x.src})`).join(' , ');
          const genTxt = hasImageSignal ? 'CÓ, ảnh đang hiện dần'
            : sig.hasStop ? 'CÓ — nút Stop (đang tạo THẬT, chờ đủ)'
              : sig.hasPlaceholder ? 'CÓ (placeholder — nghi kẹt giả)' : 'không';
          const stuckTxt = genStart ? ` | placeholder giả đứng im ${Math.round(genOnlyElapsed / 1000)}s/${Math.round(stuckCapMs / 1000)}s` : '';
          const phTxt = (d.ph && d.ph.length) ? ` | placeholder ${d.ph.map((x) => (x.inResp ? 'TRONG-RESPONSE' : 'chỉ-UI') + '(' + x.parent + ')').join(' , ')}` : '';
          log(`[${cfg.name}] 🔍 DOM: ${d.imgTotal} <img> (lớn nhất: ${top || 'không có'}) | đang-tạo: ${genTxt}${stuckTxt}${phTxt} | idle ${Math.round((now - lastProgress) / 1000)}s | ${Math.round((now - start) / 1000)}s`);
        }
      }

      // QUYET DINH cho/bo bang LOGIC THUAN (test duoc).
      const verdict = waitVerdict({ hasStop: sig.hasStop, hasPlaceholder: sig.hasPlaceholder, hasImageSignal, idleElapsed: now - lastProgress, idleMs, totalElapsed: now - start, hardCapMs, absMaxMs, genOnlyElapsed, stuckCapMs });
      if (verdict === 'giveup-idle') {
        return { ok: false, error: cfg.name + ' không có tín hiệu đang tạo suốt ' + Math.round((now - lastProgress) / 1000) + 's (tắc) — bỏ sớm, thử nguồn kế.' };
      }
      if (verdict === 'giveup-stuck') {
        return { ok: false, error: cfg.name + ' chỉ có placeholder đứng im ' + Math.round(genOnlyElapsed / 1000) + 's (kẹt giả, không ra ảnh thật) — bỏ sớm, thử nguồn kế.' };
      }
      if (verdict === 'giveup-hardcap') {
        return { ok: false, error: cfg.name + ' quá ' + Math.round((now - start) / 1000) + 's chưa ra ảnh (hết tín hiệu làm việc) — dừng, thử nguồn kế.' };
      }
      await delay(1800); // cho 1.8s roi thu lai (retry)
    }
  } catch (e) {
    return { ok: false, error: cfg.name + ' lỗi: ' + e.message };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

module.exports = { generate, PROVIDERS, dataUrlToBuffer, detectGenerating, waitVerdict, firstMatch };
