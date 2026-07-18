'use strict';

/**
 * Dieu khien cac AI ban WEB (ChatGPT / Claude / Gemini) bang cua so Electron,
 * KHONG dung API (khong ton phi). Moi nha cung cap co 1 "partition" rieng de
 * giu phien dang nhap doc lap.
 *
 *  login(provider)        : mo cua so cho nguoi dung dang nhap thu cong (1 lan).
 *  ask(provider, prompt)  : mo trang, dan prompt, doi tra loi, lay text ve.
 *  logout(provider)       : xoa phien de doi tai khoan.
 *
 * Selector co the doi theo thoi gian -> chinh o PROVIDERS khi can.
 */

const { BrowserWindow, session } = require('electron');

const PROVIDERS = {
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    partition: 'persist:chatgpt',
    composer: '#prompt-textarea, textarea#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"]',
    // Luu y: nut gui CHI xuat hien sau khi o nhap co chu (da kiem chung UI 2026-07)
    sendButton: 'button[data-testid="send-button"], #composer-submit-button, button[data-testid="composer-submit-button"], button[aria-label="Send prompt"]',
    stopButton: 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], #composer-stop-button, button[aria-label="Stop generating"], button[aria-label="Stop streaming"]',
    assistant: '[data-message-author-role="assistant"]',
  },
  claude: {
    name: 'Claude',
    url: 'https://claude.ai/new',
    partition: 'persist:claude',
    composer: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
    sendButton: 'button[aria-label="Send message"], button[aria-label="Send Message"]',
    stopButton: 'button[aria-label="Stop response"]',
    assistant: 'div.font-claude-message, [data-testid="user-message"] ~ div, div.font-claude-response',
  },
  gemini: {
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    partition: 'persist:gemini',
    composer: 'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"]',
    sendButton: 'button[aria-label="Send message"], button.send-button, button[aria-label="Gửi"]',
    stopButton: 'button[aria-label="Stop response"], button.stop',
    assistant: 'message-content, .model-response-text, div.markdown',
  },
};

function cfgOf(provider) {
  return PROVIDERS[provider] || PROVIDERS.chatgpt;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeWindow(partition, show) {
  return new BrowserWindow({
    width: 1200, height: 900, show,
    title: 'AI - Biên Tập Báo',
    webPreferences: { partition, backgroundThrottling: false, sandbox: true },
  });
}

async function jsEval(wc, code) {
  try { return await wc.executeJavaScript(code, true); } catch (_) { return null; }
}

async function waitForComposer(wc, composer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await jsEval(wc, `!!document.querySelector(${JSON.stringify(composer)})`);
    if (ok) return true;
    await delay(400); // kiem tra day hon -> vao viec som hon
  }
  return false;
}

async function lastText(wc, assistant) {
  return (await jsEval(wc, `(function(){var a=document.querySelectorAll(${JSON.stringify(assistant)}); if(!a.length) return ''; return a[a.length-1].innerText||'';})()`)) || '';
}

async function isStreaming(wc, stop) {
  return !!(await jsEval(wc, `!!document.querySelector(${JSON.stringify(stop)})`));
}

/**
 * Mo cua so cho nguoi dung dang nhap THU CONG. KHONG tu dong dong - de nguoi
 * dung tu dang nhap (ke ca 2FA / chon tai khoan / captcha) roi TU DONG CUA SO.
 * Phien duoc luu vao partition. Tra ve khi nguoi dung dong cua so.
 */
function login(provider, { timeoutMs = 600000 } = {}) {
  const cfg = cfgOf(provider);
  return new Promise((resolve) => {
    const win = makeWindow(cfg.partition, true);
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
      if (!win.isDestroyed()) win.close();
    };
    // Het gio an toan (neu de quen cua so mo)
    const timer = setTimeout(() => finish({ ok: true, message: 'Hết thời gian chờ — đã lưu phiên hiện tại của ' + cfg.name + '.' }), timeoutMs);
    // Nguoi dung dong cua so => coi nhu xong, phien da luu
    win.on('closed', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, message: 'Đã lưu phiên ' + cfg.name + '. Nếu bạn đã đăng nhập xong thì giờ có thể dùng được.' });
    });
    win.loadURL(cfg.url).catch(() => {});
  });
}

/**
 * LOI: gui 1 prompt tren cua so ĐÃ MO SAN trang chat (composer đã sẵn sàng),
 * đợi câu trả lời và lấy text. Tách riêng để dùng cho cả ask() 1 phát lẫn phiên tab tái dùng.
 */
async function runPrompt(wc, cfg, prompt, timeoutMs) {
  // Chen prompt NGAY TRONG trang bang execCommand('insertText') — cach nay an voi
  // ProseMirror/contenteditable cua UI moi (wc.insertText bi UI moi bo qua -> o trong,
  // nut gui khong bao gio hien, tool ngoi cho vo ich). Co KIEM TRA + du phong.
  const composerLen = () => jsEval(wc,
    `(function(){var e=document.querySelector(${JSON.stringify(cfg.composer)}); return e ? (e.innerText||e.value||'').trim().length : -1;})()`);

  await jsEval(wc, `(function(){
    var el = document.querySelector(${JSON.stringify(cfg.composer)});
    if (!el) return false;
    el.focus();
    try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch(_){}
    try { return document.execCommand('insertText', false, ${JSON.stringify(prompt)}); } catch(_){ return false; }
  })()`);
  await delay(600);

  let len = await composerLen();
  if (len < 50) {
    // Du phong: go qua Electron (cach cu)
    await jsEval(wc, `(function(){var e=document.querySelector(${JSON.stringify(cfg.composer)}); if(e){e.focus();}})()`);
    await delay(300);
    wc.insertText(prompt);
    await delay(700);
    len = await composerLen();
  }
  if (len < 50) {
    return { ok: false, error: 'Không gõ được prompt vào ' + cfg.name + ' (giao diện web có thể vừa đổi). Thử đăng nhập lại hoặc đổi động cơ AI khác.' };
  }

  // Gui: bam nut send; KIEM TRA da gui that (dang stream hoac o nhap da rong); chua thi Enter
  const trySendClick = () => jsEval(wc,
    `(function(){var b=document.querySelector(${JSON.stringify(cfg.sendButton)}); if(b && !b.disabled){b.click(); return true;} return false;})()`);
  const isSent = async () => {
    if (await isStreaming(wc, cfg.stopButton)) return true;
    const l = await composerLen();
    return l >= 0 && l < 5;
  };
  await trySendClick();
  await delay(1200);
  if (!(await isSent())) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await delay(1200);
    if (!(await isSent())) await trySendClick();
    await delay(800);
    if (!(await isSent())) {
      return { ok: false, error: 'Đã gõ prompt nhưng không bấm gửi được trên ' + cfg.name + ' (không thấy nút gửi). Giao diện web có thể vừa đổi.' };
    }
  }

  // Doi tra loi: stream chay roi dung + text on dinh. (Cat bot cho thua -> nhanh hon)
  await delay(1500);
  const deadline = Date.now() + timeoutMs;
  let prev = '';
  let stable = 0;
  while (Date.now() < deadline) {
    const streaming = await isStreaming(wc, cfg.stopButton);
    const txt = await lastText(wc, cfg.assistant);
    if (!streaming && txt && txt === prev) {
      stable++;
      if (stable >= 2) break; // 2 lan lien tiep text khong doi + het stream -> coi nhu xong
    } else {
      stable = 0;
      prev = txt;
    }
    await delay(900);
  }

  const text = await lastText(wc, cfg.assistant);
  if (!text || text.length < 10) {
    return { ok: false, error: 'Không lấy được câu trả lời từ ' + cfg.name + ' (có thể bị chặn hoặc giao diện đổi).' };
  }
  return { ok: true, text };
}

// Hoi 1 phat: mo cua so, load trang, gui prompt, dong cua so. (giu cho cac cho dung le)
async function ask(provider, { prompt, show = true, timeoutMs = 300000 } = {}) {
  const cfg = cfgOf(provider);
  const win = makeWindow(cfg.partition, show);
  const wc = win.webContents;
  try {
    await win.loadURL(cfg.url).catch(() => {});
    if (!(await waitForComposer(wc, cfg.composer, 20000))) {
      return { ok: false, error: 'Chưa đăng nhập ' + cfg.name + ' (không thấy ô nhập). Vào Cài đặt → "Đăng nhập ' + cfg.name + '" trước.' };
    }
    return await runPrompt(wc, cfg, prompt, timeoutMs);
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

/**
 * Mo 1 "phien tab" GIU CUA SO MO — dịch nhiều prompt liên tiếp trong cùng 1 cửa sổ.
 * Mỗi lần .ask() sẽ MỞ ĐOẠN CHAT MỚI (load lại URL) để không bị dồn ngữ cảnh cũ.
 * Dùng cho dịch nhiều tiếng: mỗi tab lo vài tiếng, nhiều tab chạy song song.
 *
 *   const s = await webai.openSession('chatgpt');
 *   const r1 = await s.ask(prompt1); const r2 = await s.ask(prompt2);
 *   s.close();
 */
async function openSession(provider, { show = false } = {}) {
  const cfg = cfgOf(provider);
  const win = makeWindow(cfg.partition, show);
  const wc = win.webContents;
  let closed = false;
  win.on('closed', () => { closed = true; });
  return {
    provider,
    name: cfg.name,
    async ask(prompt, { timeoutMs = 300000 } = {}) {
      if (closed || win.isDestroyed()) return { ok: false, error: 'Cửa sổ ' + cfg.name + ' đã đóng.' };
      try {
        await win.loadURL(cfg.url).catch(() => {}); // moi lan = doan chat moi
        if (!(await waitForComposer(wc, cfg.composer, 20000))) {
          return { ok: false, error: 'Chưa đăng nhập ' + cfg.name + ' (không thấy ô nhập). Vào Cài đặt → "Đăng nhập ' + cfg.name + '" trước.' };
        }
        return await runPrompt(wc, cfg, prompt, timeoutMs);
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    close() { if (!win.isDestroyed()) win.close(); },
  };
}

async function logout(provider) {
  const cfg = cfgOf(provider);
  try {
    const ses = session.fromPartition(cfg.partition);
    await ses.clearStorageData();
    await ses.clearCache().catch(() => {});
    return { ok: true, message: 'Đã đăng xuất ' + cfg.name + '. Bấm "Đăng nhập ' + cfg.name + '" để vào tài khoản khác.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { login, ask, openSession, logout, PROVIDERS };
