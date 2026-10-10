/**
 * preload —— 唯一桥接层。
 * 渲染进程通过 window.cleandub.invoke(channel, payload) 访问主进程，
 * 通过 window.cleandub.on(channel, cb) 订阅事件（扫描进度等）。
 * contextIsolation=true，禁止 nodeIntegration。
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'choose-directories',
  'start-scan',
  'cancel-scan',
  'get-scan-progress',
  'get-scan-history',
  'get-duplicate-groups',
  'set-retained-file',
  'apply-retention-strategy',
  'quarantine-files',
  'permanently-delete-files',
  'restore-quarantined-files',
  'get-quarantine-items',
  'delete-scan-history',
  'get-app-settings',
  'update-app-settings',
  'check-updates',
  'open-external',
  'get-operation-logs',
  'reset-app-data',
  'window:is-maximized'
]);

const EVENT_CHANNELS = new Set(['scan-progress', 'scan-state']);

contextBridge.exposeInMainWorld('cleandub', {
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error('未知 IPC 通道: ' + channel));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, callback) {
    if (!EVENT_CHANNELS.has(channel)) throw new Error('未知事件通道: ' + channel);
    const listener = (_evt, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // 窗口控制（标题栏按钮）
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized')
  }
});
