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
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    function fire(el, type){ try{ el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window})); }catch(e){} }
    function hover(el){ fire(el,'pointerover'); fire(el,'mouseover'); fire(el,'mouseenter'); fire(el,'pointermove'); fire(el,'mousemove'); }
    // tim phan tu KHOP text trong 1 menu/dialog dang mo (toan trang)
    function findByText(reText, roles){
      var sel = roles || 'button,[role="menuitem"],[role="menuitemradio"],a,div[role="button"]';
      var els = Array.prototype.slice.call(document.querySelectorAll(sel));
      for(var i=0;i<els.length;i++){ if(vis(els[i]) && reText.test(txt(els[i]))) return els[i]; }
      return null;
    }

    var links = Array.prototype.slice.call(document.querySelectorAll('a[href^="/chat/"], a[href*="/chat/"]'));
    if(!links.length) return {ok:false, reason:'khong thay cuoc tro chuyen nao (chua dang nhap?)'};
    var link = links[0];
    var title = txt(link).slice(0,60) || (link.getAttribute('href')||'');
    var before = links.length;
    var item = link.closest('li,[data-testid],[role="listitem"]') || link.parentElement || link;

    // 1) Hien nut menu: hover ca item lan link
    hover(item); hover(link); await sleep(350);

    // Ung vien nut menu "..." (nhieu kha nang)
    var cands = [];
    function addAll(root){ if(!root)return; Array.prototype.push.apply(cands, Array.prototype.slice.call(root.querySelectorAll(
      'button[aria-haspopup="menu"],button[aria-label*="menu" i],button[aria-label*="option" i],button[aria-label*="more" i],'
      +'button[data-testid*="menu" i],button[data-testid*="option" i],[data-testid*="menu" i][role="button"],'
      +'button[aria-label*="tùy chọn" i],button[aria-label*="conversation" i],button[aria-haspopup="true"]'))); }
    addAll(item); addAll(item.parentElement); addAll(link.parentElement);
    // du phong: nut cuoi cung trong item chi co icon (khong chu)
    var allBtns = Array.prototype.slice.call(item.querySelectorAll('button')).filter(vis);
    var iconBtns = allBtns.filter(function(b){ return txt(b).length===0; });
    var menuBtn = cands.filter(vis)[0] || iconBtns[iconBtns.length-1] || null;

    // Log cau truc nut de chan doan (khi giao dien doi)
    var diag = allBtns.map(function(b){ return (b.getAttribute('aria-label')||b.getAttribute('data-testid')||txt(b)||'?'); }).slice(0,8);

    if(!menuBtn){
      // du phong cuoi: chuot phai (context menu)
      fire(link,'contextmenu'); await sleep(400);
      var delRC = findByText(/^(delete|xóa|xoá)\\b/i);
      if(!delRC) return {ok:false, reason:'khong thay nut menu (...) — cac nut thay: ['+diag.join(' | ')+']', title:title};
      delRC.click(); await sleep(400);
    } else {
      menuBtn.click(); await sleep(500);
      var delItem = findByText(/^(delete|xóa|xoá)\\b/i);
      if(!delItem){
        // co the menu mo cham / can hover menuBtn
        hover(menuBtn); await sleep(400);
        delItem = findByText(/^(delete|xóa|xoá)\\b/i);
      }
      if(!delItem) return {ok:false, reason:'mo menu nhung khong thay muc Delete — cac nut item: ['+diag.join(' | ')+']', title:title};
      delItem.click(); await sleep(450);
    }

    // 3) Hop thoai xac nhan (Radix dialog): nut Delete/Xoa
    var confirmBtn = findByText(/^(delete|xóa|xoá|confirm|đồng ý|remove)$/i);
    if(confirmBtn){ confirmBtn.click(); await sleep(800); }

    // 4) Xac nhan danh sach da giam
    var after = document.querySelectorAll('a[href^="/chat/"], a[href*="/chat/"]').length;
    if(after < before) return {ok:true, title:title};
    await sleep(900);
    after = document.querySelectorAll('a[href^="/chat/"], a[href*="/chat/"]').length;
    if(after < before) return {ok:true, title:title};
    return {ok:false, reason:'da bam Delete nhung danh sach chua giam (giao dien co the doi)', title:title};
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
