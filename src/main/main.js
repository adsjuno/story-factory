'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

app.setName('story-factory');       // userData co dinh -> khong lac tai khoan
app.disableHardwareAcceleration();  // on dinh tren may driver GPU yeu (giu tu ban cu)

const store = require('./store');
const supabase = require('./supabase');
const storyWriter = require('./story-writer');
const storyDna = require('./story-dna');
const storyMemory = require('./story-memory');
const conflictTree = require('./conflict-tree');
const sheets = require('./sheets');
const webai = require('./webai-electron');
const claudeCleanup = require('./claude-cleanup');
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
  const img = s.image || {};
  const dec = (v) => { try { return store.decryptSecret(v); } catch (_) { return ''; } };
  return {
    ok: true,
    sheets: { webhookUrl: s.sheets?.webhookUrl || '' },
    story: {
      niches: (s.story && s.story.niches) || storyWriter.DEFAULT_NICHES,
      skillCommand: (s.story && s.story.skillCommand) || storyWriter.DEFAULT_SKILL_COMMAND,
      cleanupClaudeChats: !(s.story && s.story.cleanupClaudeChats === false), // mac dinh bat
    },
    image: {
      cfAccountId: dec(img.cfAccountId),
      cfApiToken: dec(img.cfApiToken),
      r2AccessKeyId: dec(img.r2AccessKeyId),
      r2SecretAccessKey: dec(img.r2SecretAccessKey),
      r2Endpoint: img.r2Endpoint || '',
      r2Bucket: img.r2Bucket || 'story-factory',
      r2PublicDomain: img.r2PublicDomain || 'https://cdn-story.jovaaqua.com',
      source: {
        order: (img.source && Array.isArray(img.source.order) && img.source.order.length) ? img.source.order : ['gemini', 'chatgpt', 'cloudflare'],
        enabled: (img.source && img.source.enabled) || { gemini: true, chatgpt: true, cloudflare: false },
        showWindow: !!(img.source && img.source.showWindow),
      },
    },
  };
});
// Cai dat "Anh & Luu tru": Cloudflare Workers AI + R2. Secret duoc MA HOA truoc khi luu.
ipcMain.handle('settings:saveImage', (_e, payload) => {
  requireAuth();
  const p = payload || {};
  const s = loadSettings();
  s.image = s.image || {};
  s.image.cfAccountId = store.encryptSecret(String(p.cfAccountId || '').trim());
  s.image.cfApiToken = store.encryptSecret(String(p.cfApiToken || '').trim());
  delete s.image.geminiKey; // bo key Gemini cu (khong dung nua)
  s.image.r2AccessKeyId = store.encryptSecret(String(p.r2AccessKeyId || '').trim());
  s.image.r2SecretAccessKey = store.encryptSecret(String(p.r2SecretAccessKey || '').trim());
  s.image.r2Endpoint = String(p.r2Endpoint || '').trim();
  s.image.r2Bucket = String(p.r2Bucket || '').trim() || 'story-factory';
  s.image.r2PublicDomain = String(p.r2PublicDomain || '').trim().replace(/\/+$/, '');
  // Nguon tao anh (thu tu + bat/tat + hien cua so)
  if (p.source && typeof p.source === 'object') {
    s.image.source = s.image.source || {};
    if (Array.isArray(p.source.order)) s.image.source.order = p.source.order;
    if (p.source.enabled && typeof p.source.enabled === 'object') s.image.source.enabled = p.source.enabled;
    s.image.source.showWindow = !!p.source.showWindow;
  }
  saveSettings(s);
  return { ok: true };
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
ipcMain.handle('settings:saveStory', (_e, { niches, skillCommand, cleanupClaudeChats }) => {
  requireAuth();
  const s = loadSettings();
  s.story = s.story || {};
  if (Array.isArray(niches)) s.story.niches = niches;
  if (typeof skillCommand === 'string' && skillCommand.trim()) s.story.skillCommand = skillCommand;
  if (typeof cleanupClaudeChats === 'boolean') s.story.cleanupClaudeChats = cleanupClaudeChats;
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

    // TU DON CHAT CLAUDE: chi sau khi da day Sheet THANH CONG (khong mat du lieu).
    // Mac dinh bat; loi don chat KHONG lam sap ket qua viet bai.
    const cleanupOn = !(s.story && s.story.cleanupClaudeChats === false);
    if (cleanupOn && result.rows.length) {
      try {
        const showWin = !!(s.image && s.image.source && s.image.source.showWindow);
        await claudeCleanup.cleanupRecent(result.rows.length, {
          show: showWin,
          log: (m) => mainWindow.webContents.send('story:progress', { message: m }),
        });
      } catch (e) {
        mainWindow.webContents.send('story:progress', { message: '⚠️ Không dọn được chat Claude: ' + e.message + ' (bài vẫn xong).' });
      }
    }

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

// ---------------- IPC: Log (xem nguyen van ket qua Claude tra ve) ----------------
ipcMain.handle('logs:get', () => {
  requireAuth();
  const l = store.readRawLog();
  return { ok: true, raw: l.raw, meta: l.meta, history: l.history, dir: l.dir, file: l.file };
});
ipcMain.handle('logs:openFolder', async () => {
  requireAuth();
  try {
    const dir = store.getLogsDir();
    await shell.openPath(dir);
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------- IPC: Story DNA (pool da quoc gia + nuoc dang chay) ----------------
function loadRunningCountry() {
  const s = loadSettings();
  return ((s.dna && s.dna.runningCountry) || storyDna.DEFAULT_COUNTRY).toUpperCase();
}
ipcMain.handle('dna:get', () => {
  requireAuth();
  return {
    ok: true,
    axes: storyDna.AXES,
    countries: storyDna.listCountries(),
    running: loadRunningCountry(),
    stats: storyMemory.stats(),
  };
});
ipcMain.handle('dna:getPool', (_e, { country }) => {
  requireAuth();
  return { ok: true, country: String(country || storyDna.DEFAULT_COUNTRY).toUpperCase(), pool: storyDna.getPool(country) };
});
ipcMain.handle('dna:savePool', (_e, { country, pool }) => {
  requireAuth();
  return storyDna.savePool(country, pool);
});
ipcMain.handle('dna:setRunning', (_e, { country }) => {
  requireAuth();
  const s = loadSettings();
  s.dna = s.dna || {};
  s.dna.runningCountry = String(country || storyDna.DEFAULT_COUNTRY).toUpperCase();
  saveSettings(s);
  return { ok: true, running: s.dna.runningCountry };
});

// ---------------- IPC: Conflict tree (theo nuoc + ngach) ----------------
ipcMain.handle('conflict:get', (_e, { country }) => {
  requireAuth();
  return { ok: true, country: String(country || storyDna.DEFAULT_COUNTRY).toUpperCase(), branches: conflictTree.listBranches(country) };
});
ipcMain.handle('conflict:getBranch', (_e, { country, branch }) => {
  requireAuth();
  return { ok: true, data: conflictTree.getBranch(country, branch) };
});
ipcMain.handle('conflict:saveBranch', (_e, { country, branch, data }) => {
  requireAuth();
  return conflictTree.saveBranch(country, branch, data);
});
