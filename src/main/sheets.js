'use strict';

/**
 * Ghi ket qua vao Google Sheets qua Google Apps Script Web App (MIEN PHI, khong can API key/OAuth).
 * Bo cuc moi: moi BAI = 1 DONG, 16 cot (FB + web + prompt anh) - de n8n cao dung.
 *
 * Cach cai: xem docs/GOOGLE-SHEETS-SETUP.md (Apps Script tu tao header 16 cot).
 */

// Ghi 1 dong (1 bai)
async function appendRow(webhookUrl, row) {
  return appendRows(webhookUrl, [row]);
}

// Ghi NHIEU dong 1 lan (viet batch nhieu bai) - it goi mang hon
async function appendRows(webhookUrl, rows) {
  const url = String(webhookUrl || '').trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\//i.test(url)) {
    throw new Error('URL Google Apps Script không hợp lệ (phải dạng https://script.google.com/macros/s/.../exec).');
  }
  if (!rows || !rows.length) throw new Error('Không có dòng nào để ghi.');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // tranh preflight
      body: JSON.stringify({ rows }),   // gui MANG dong
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error('Không gọi được Google Apps Script (kiểm tra mạng/URL): ' + e.message);
  }
  const txt = await res.text();
  if (!res.ok) throw new Error('Google Apps Script trả lỗi HTTP ' + res.status + '. Kiểm tra URL deploy (/exec, Access: Anyone).');
  let data = null;
  try { data = JSON.parse(txt); } catch (_) { /* co the tra HTML khi loi quyen */ }
  if (data && data.ok === false) throw new Error('Apps Script báo lỗi: ' + (data.error || 'không rõ'));
  if (!data) throw new Error('Apps Script không trả về JSON — kiểm tra deploy (Execute as "Me", Access "Anyone", URL /exec).');
  return { ok: true, written: rows.length };
}

/**
 * XOA cac dong theo status (vd 'draft_test') — can Apps Script ban MOI co xu ly
 * action='delete_status'. Ban Apps Script cu se bao loi -> tra thong bao huong dan cap nhat.
 */
async function deleteByStatus(webhookUrl, status) {
  const url = String(webhookUrl || '').trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\//i.test(url)) {
    throw new Error('URL Google Apps Script không hợp lệ.');
  }
  const st = String(status || '').trim();
  if (!st) throw new Error('Thiếu status cần xoá.');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'delete_status', status: st }),
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error('Không gọi được Google Apps Script: ' + e.message);
  }
  const txt = await res.text();
  if (!res.ok) throw new Error('Apps Script trả lỗi HTTP ' + res.status);
  let data = null;
  try { data = JSON.parse(txt); } catch (_) {}
  if (!data) throw new Error('Apps Script không trả JSON — kiểm tra deploy.');
  if (data.ok === false) {
    // Ban Apps Script cu chua ho tro action -> bao ro cach xu ly
    throw new Error('Apps Script chưa hỗ trợ xoá (' + (data.error || '') + '). '
      + 'Hãy dán bản Apps Script mới (có action delete_status) rồi Deploy → New version.');
  }
  return { ok: true, deleted: data.deleted != null ? data.deleted : 0 };
}

module.exports = { appendRow, appendRows, deleteByStatus };
