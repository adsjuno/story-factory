'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bao moi lenh: neu main nem loi thi tra ve {ok:false,error} thay vi reject am tham.
function call(channel, payload) {
  return ipcRenderer.invoke(channel, payload).catch((e) => ({
    ok: false,
    error: (e && e.message ? e.message : String(e)).replace(/^Error:\s*/, ''),
  }));
}

const api = {
  // Auth
  login: (p) => call('auth:login', p),
  logout: () => call('auth:logout'),
  me: () => call('auth:me'),
  changePassword: (p) => call('auth:changePassword', p),
  createUser: (p) => call('auth:createUser', p),
  listUsers: () => call('auth:listUsers'),
  deleteUser: (p) => call('auth:deleteUser', p),
  setPassword: (p) => call('auth:setPassword', p),
  setActive: (p) => call('auth:setActive', p),

  // Settings
  getSettings: () => call('settings:get'),
  saveSheets: (p) => call('settings:saveSheets', p),
  saveStory: (p) => call('settings:saveStory', p),  // tuy bien ngach + cau lenh skill
  saveImage: (p) => call('settings:saveImage', p),  // Cloudflare Workers AI + R2 (Anh & Luu tru)
  aiLogin: (p) => call('settings:aiLogin', p),
  aiLogout: (p) => call('settings:aiLogout', p),

  // Update
  updateInfo: () => call('update:info'),
  checkUpdate: () => call('update:check'),
  onUpdateEvent: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('update:event', h);
    return () => ipcRenderer.removeListener('update:event', h);
  },

  // Story (viet truyen)
  getNiches: () => call('story:niches'),
  write: (p) => call('story:write', p),
  sheetsTest: () => call('sheets:test'),
  listJobs: () => call('jobs:list'),

  // Log (xem nguyen van ket qua Claude tra ve khi loi "thieu khuon")
  getLogs: () => call('logs:get'),
  openLogsFolder: () => call('logs:openFolder'),

  // Story DNA (pool da quoc gia)
  dnaGet: () => call('dna:get'),
  dnaGetPool: (p) => call('dna:getPool', p),
  dnaSavePool: (p) => call('dna:savePool', p),
  dnaSetRunning: (p) => call('dna:setRunning', p),
  onProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('story:progress', h);
    return () => ipcRenderer.removeListener('story:progress', h);
  },
};

contextBridge.exposeInMainWorld('appBridge', api);
