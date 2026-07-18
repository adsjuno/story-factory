'use strict';

/**
 * Ket noi tai khoan TAP TRUNG qua Supabase (database online).
 * App chi dung PUBLISHABLE key (cong khai duoc). Moi thao tac nhay cam
 * (tao/xoa/khoa acc) deu qua cac ham co kiem soat quyen tren database.
 *
 * Tai khoan KHONG con luu cuc bo -> admin quan ly tap trung moi may.
 */

const SUPABASE_URL = 'https://qraasmepsyhoguiwahlb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fCwmuvg3vcRHdZ8n8vvJHg_q0SSiPsw';

async function rpc(fn, body) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
      return { ok: false, error: 'Máy chủ lỗi: ' + msg };
    }
    return data || { ok: false, error: 'Máy chủ trả về rỗng' };
  } catch (e) {
    return { ok: false, error: 'Không kết nối được máy chủ (kiểm tra internet). Chi tiết: ' + e.message };
  }
}

module.exports = {
  login: (username, password) => rpc('app_login', { p_username: username, p_password: password }),
  createUser: (token, { username, password, displayName, role }) =>
    rpc('app_create_user', { p_token: token, p_username: username, p_password: password, p_display: displayName || '', p_role: role || 'staff' }),
  listUsers: (token) => rpc('app_list_users', { p_token: token }),
  deleteUser: (token, userId) => rpc('app_delete_user', { p_token: token, p_user_id: userId }),
  setPassword: (token, userId, newPass) => rpc('app_set_password', { p_token: token, p_user_id: userId, p_newpass: newPass }),
  setActive: (token, userId, active) => rpc('app_set_active', { p_token: token, p_user_id: userId, p_active: active }),
  changePassword: (token, oldPass, newPass) => rpc('app_change_password', { p_token: token, p_old: oldPass, p_new: newPass }),
  stats: (token) => rpc('app_stats', { p_token: token }),
};
