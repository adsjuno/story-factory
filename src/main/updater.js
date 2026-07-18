'use strict';

/**
 * Tu dong cap nhat qua GitHub Releases (electron-updater).
 * Chi hoat dong o BAN DA CAI (.exe). Ban dev (chay ma nguon) luon moi nhat nen bo qua.
 *
 * Luong: check -> neu co ban moi -> download -> install (quitAndInstall).
 */

const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

let win = null;
function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function init(mainWindow) {
  win = mainWindow;
  autoUpdater.autoDownload = false;          // tai khi nguoi dung bam
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => send('update:event', { type: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send('update:event', { type: 'none' }));
  autoUpdater.on('download-progress', (p) => send('update:event', { type: 'progress', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update:event', { type: 'downloaded', version: info.version }));
  autoUpdater.on('error', (e) => send('update:event', { type: 'error', error: (e && e.message) || String(e) }));

  // Tu kiem tra 1 lan sau khi mo (chi ban da cai)
  if (app.isPackaged) {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 8000);
  }
}

ipcMain.handle('update:info', () => ({ ok: true, version: app.getVersion(), packaged: app.isPackaged }));

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) {
    return { ok: true, current: app.getVersion(), hasUpdate: false, dev: true };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    return { ok: true, current: app.getVersion(), latest, hasUpdate: !!(latest && latest !== app.getVersion()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update:download', async () => {
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall(); return { ok: true }; });

module.exports = { init };
