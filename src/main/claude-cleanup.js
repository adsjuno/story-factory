'use strict';

/**
 * TU DON LICH SU CHAT CLAUDE sau khi bai da viet xong + day len Sheet thanh cong.
 * Moi bai = 1 phien chat moi -> list chat bi don u. Module nay xoa cac chat vua tao.
 *
 * TACH RIENG khoi webai-electron.js (KHONG sua logic viet truyen). Dung chung partition
 * dang nhap 'persist:claude' nen khong can dang nhap lai.
 *
 * AN TOAN: chi bam khi TIM DUNG nut menu + muc "Delete" (khop text). Khong tim thay ->
 * bo qua, LOG ro, KHONG throw (khong lam sap luong viet bai). Noi dung bai da o Sheet nen
 * xoa chat khong mat du lieu.
 */

const { BrowserWindow } = require('electron');

const CLAUDE_URL = 'https://claude.ai/';
const PARTITION = 'persist:claude';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function jsEval(wc, code) { try { return await wc.executeJavaScript(code, true); } catch (_) { return null; } }

function makeWindow(show) {
  return new BrowserWindow({
    width: 1100, height: 850, show: !!show,
    title: 'Dọn lịch sử chat Claude',
    webPreferences: { partition: PARTITION, backgroundThrottling: false, sandbox: true },
  });
}

// Doi sidebar co link cuoc tro chuyen /chat/...
async function waitSidebar(wc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await jsEval(wc, `document.querySelectorAll('a[href^="/chat/"]').length`);
    if (n && n > 0) return true;
    await delay(500);
  }
  return false;
}

/**
 * Xoa 1 cuoc tro chuyen GAN NHAT (dau danh sach). Tra ve:
 *  {ok:true, title} | {ok:false, reason}
 * Cach lam THAN TRONG (thuc thi trong trang):
 *  - lay item chat dau tien (href /chat/..)
 *  - tim nut menu "..." trong/canh item -> click
 *  - tim muc menu co chu Delete/Xoa -> click
 *  - tim nut xac nhan Delete/Xoa trong hop thoai -> click
 *  - KHONG tim thay bat ky buoc nao -> tra ly do, KHONG bam bua
 */
async function deleteFirstChat(wc) {
  const code = `(async function(){
    function txt(el){ return (el && (el.innerText||el.textContent) || '').trim(); }
    function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); return r.width>0&&r.height>0; }
    function clickable(root, reText){
      var els = Array.prototype.slice.call(root.querySelectorAll('button,[role="menuitem"],a,div[role="button"]'));
      for(var i=0;i<els.length;i++){ if(vis(els[i]) && reText.test(txt(els[i]))) return els[i]; }
      return null;
    }
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

    var links = Array.prototype.slice.call(document.querySelectorAll('a[href^="/chat/"]'));
    if(!links.length) return {ok:false, reason:'khong thay cuoc tro chuyen nao'};
    var link = links[0];
    var title = txt(link).slice(0,60) || (link.getAttribute('href')||'');
    var before = links.length;

    // Container cua item (li hoac div cha) de tim nut menu
    var item = link.closest('li') || link.parentElement || link;

    // 1) Tim nut menu "..." (nhieu kha nang selector). Hover truoc cho menu button hien.
    try{ item.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); item.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); }catch(e){}
    await sleep(250);
    var menuBtn =
      item.querySelector('button[aria-haspopup="menu"], button[aria-label*="menu" i], button[aria-label*="options" i], button[data-testid*="menu" i], button[id*="menu" i], button[aria-label*="tùy chọn" i]')
      || item.querySelector('button');
    if(!menuBtn || !vis(menuBtn)) return {ok:false, reason:'khong thay nut menu (...) cua chat', title:title};
    menuBtn.click();
    await sleep(400);

    // 2) Muc "Delete"/"Xóa" trong menu vua mo (tim toan trang vi menu render o body)
    var delItem = clickable(document, /^(delete|xóa|xoá|delete chat|xóa cuộc trò chuyện)/i);
    if(!delItem) return {ok:false, reason:'khong thay muc Delete trong menu', title:title};
    delItem.click();
    await sleep(400);

    // 3) Nut xac nhan trong hop thoai (neu co)
    var confirmBtn = clickable(document, /^(delete|xóa|xoá|confirm|đồng ý|ok)$/i);
    if(confirmBtn){ confirmBtn.click(); await sleep(700); }

    // 4) Kiem tra so cuoc tro chuyen da giam (xac nhan xoa)
    var after = document.querySelectorAll('a[href^="/chat/"]').length;
    if(after < before) return {ok:true, title:title};
    // co the UI cham cap nhat -> cho them 1 nhip
    await sleep(800);
    after = document.querySelectorAll('a[href^="/chat/"]').length;
    if(after < before) return {ok:true, title:title};
    return {ok:false, reason:'da bam Delete nhung danh sach chua giam (co the giao dien doi)', title:title};
  })()`;
  return (await jsEval(wc, code)) || { ok: false, reason: 'loi thuc thi trong trang' };
}

/**
 * Xoa `count` cuoc tro chuyen gan nhat. Dung ngay khi 1 lan that bai (tranh bam nham lan tiep).
 * @returns {ok, deleted, error?}
 */
async function cleanupRecent(count, { show = false, timeoutMs = 60000, log = () => {} } = {}) {
  const n = Math.max(0, Math.min(50, parseInt(count, 10) || 0));
  if (!n) return { ok: true, deleted: 0 };

  const win = makeWindow(show);
  const wc = win.webContents;
  let deleted = 0;
  try {
    log('🧹 Dọn lịch sử chat Claude...');
    await win.loadURL(CLAUDE_URL).catch(() => {});
    if (!(await waitSidebar(wc, 20000))) {
      return { ok: false, deleted, error: 'Không thấy danh sách chat (chưa đăng nhập Claude hoặc giao diện đổi).' };
    }
    for (let i = 0; i < n; i++) {
      const r = await deleteFirstChat(wc);
      if (r.ok) {
        deleted++;
        log(`🧹 Đã xoá chat: "${r.title || '?'}" (${deleted}/${n})`);
        await delay(900); // cho danh sach cap nhat truoc lan xoa ke tiep
      } else {
        log(`⚠️ Dừng dọn chat: ${r.reason}${r.title ? ' (chat "' + r.title + '")' : ''}. Bài vẫn xong bình thường.`);
        break; // dung ngay, khong bam bua tiep
      }
    }
    return { ok: true, deleted };
  } catch (e) {
    log('⚠️ Lỗi dọn chat: ' + e.message + ' — bỏ qua, không ảnh hưởng bài.');
    return { ok: false, deleted, error: e.message };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

module.exports = { cleanupRecent };
