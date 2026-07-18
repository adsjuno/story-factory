'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.setName('story-factory');       // userData co dinh -> khong lac tai khoan
app.disableHardwareAcceleration();  // on dinh tren may driver GPU yeu (giu tu ban cu)

const store = require('./store');
const supabase = require('./supabase');
const storyWriter = require('./story-writer');
const sheets = require('./sheets');
const webai = require('./webai-electron');
const updater = require('./updater');

let mainWindow = null;
let session = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 820, minWidth: 940, minHeight: 640,
    title: 'Story Factory — Truyện Mỹ 55+',
    show: false, backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
  updater.init(mainWindow);
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
  mainWindow.webContents.on('console-message', (_e, _l, message, line, src) => {
    console.log(`[renderer] ${message}  (${src}:${line})`);
  });
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------------- Helpers ----------------
function loadSettings() { return store.read('settings.json'); }
function saveSettings(s) { store.write('settings.json', s); }
function requireAuth() { if (!session) throw new Error('Chưa đăng nhập'); return session.user; }
function requireToken() { if (!session) throw new Error('Chưa đăng nhập'); return session.token; }

// ---------------- IPC: Auth (giu nguyen Supabase tap trung) ----------------
ipcMain.handle('auth:login', async (_e, { username, password }) => {
  const r = await supabase.login(username, password);
  if (r.ok) session = { token: r.token, user: r.user };
  return r;
});
ipcMain.handle('auth:logout', () => { session = null; return { ok: true }; });
ipcMain.handle('auth:me', () => ({ ok: true, user: session ? session.user : null }));
ipcMain.handle('auth:changePassword', async (_e, { oldPassword, newPassword }) =>
  supabase.changePassword(requireToken(), oldPassword, newPassword));
ipcMain.handle('auth:listUsers', async () => supabase.listUsers(requireToken()));
ipcMain.handle('auth:createUser', async (_e, payload) => supabase.createUser(requireToken(), payload));
ipcMain.handle('auth:deleteUser', async (_e, { userId }) => supabase.deleteUser(requireToken(), userId));
ipcMain.handle('auth:setPassword', async (_e, { userId, newPassword }) =>
  supabase.setPassword(requireToken(), userId, newPassword));
ipcMain.handle('auth:setActive', async (_e, { userId, active }) =>
  supabase.setActive(requireToken(), userId, active));

// ---------------- IPC: Cai dat ----------------
ipcMain.handle('settings:get', () => {
  requireAuth();
  const s = loadSettings();
  return {
    ok: true,
    sheets: { webhookUrl: s.sheets?.webhookUrl || '' },
    story: {
      niches: (s.story && s.story.niches) || storyWriter.DEFAULT_NICHES,
      skillCommand: (s.story && s.story.skillCommand) || storyWriter.DEFAULT_SKILL_COMMAND,
    },
  };
});
ipcMain.handle('settings:saveSheets', (_e, { webhookUrl }) => {
  requireAuth();
  const s = loadSettings();
  s.sheets = s.sheets || {};
  s.sheets.webhookUrl = String(webhookUrl || '').trim();
  saveSettings(s);
  return { ok: true };
});
// Tuy bien: sua danh sach ngach + cau lenh goi skill (Cach 1 gon, nhung sua duoc)
ipcMain.handle('settings:saveStory', (_e, { niches, skillCommand }) => {
  requireAuth();
  const s = loadSettings();
  s.story = s.story || {};
  if (Array.isArray(niches)) s.story.niches = niches;
  if (typeof skillCommand === 'string' && skillCommand.trim()) s.story.skillCommand = skillCommand;
  saveSettings(s);
  return { ok: true };
});

// ---------------- IPC: AI web login (giu nguyen) ----------------
ipcMain.handle('settings:aiLogin', async (_e, { provider }) => {
  requireAuth();
  return webai.login(provider || 'claude', { timeoutMs: 300000 });
});
ipcMain.handle('settings:aiLogout', async (_e, { provider }) => {
  requireAuth();
  return webai.logout(provider || 'claude');
});

// ---------------- IPC: Viet truyen ----------------
ipcMain.handle('story:niches', () => { requireAuth(); return { ok: true, niches: storyWriter.getNiches() }; });

ipcMain.handle('story:write', async (_e, { niche, count }) => {
  requireAuth();
  const s = loadSettings();
  const url = s.sheets?.webhookUrl;
  if (!url) return { ok: false, error: 'Chưa cấu hình Google Sheets (Cài đặt → Google Sheets).' };

  try {
    const result = await storyWriter.writeBatch({ niche, count }, (p) => {
      mainWindow.webContents.send('story:progress', p);
    });
    if (!result.rows.length) {
      return { ok: false, error: 'Không viết được bài nào. ' + (result.failed[0] ? result.failed[0].error : '') };
    }
    // Ghi tat ca dong len Sheet 1 lan
    mainWindow.webContents.send('story:progress', { message: `Đang ghi ${result.rows.length} bài lên Google Sheet...` });
    await sheets.appendRows(url, result.rows);

    // Luu lich su gon
    const db = store.read('jobs.json');
    db.jobs = db.jobs || [];
    db.jobs.unshift({ at: new Date().toISOString(), niche, count: result.rows.length, failed: result.failed.length });
    db.jobs = db.jobs.slice(0, 500);
    store.write('jobs.json', db);

    return { ok: true, written: result.rows.length, failed: result.failed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sheets:test', async () => {
  requireAuth();
  const s = loadSettings();
  const url = s.sheets?.webhookUrl;
  if (!url) return { ok: false, error: 'Chưa dán URL Apps Script (Cài đặt → Google Sheets).' };
  try {
    const testRow = storyWriter.SHEET_COLUMNS.map((c) =>
      c === 'timestamp' ? new Date().toLocaleString('vi-VN')
      : c === 'status' ? 'test'
      : c === 'web_title' ? 'Dòng chạy thử — có thể xoá' : '');
    await sheets.appendRow(url, testRow);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('jobs:list', () => { requireAuth(); return { ok: true, jobs: store.read('jobs.json').jobs }; });
