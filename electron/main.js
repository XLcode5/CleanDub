/**
 * CleanDub 主进程入口
 * - 单实例锁、窗口生命周期、自定义标题栏控件
 * - 注册全部 IPC（choose_directories / start_scan / cancel_scan / ...）
 * - 渲染进程打包后加载 dist-renderer/index.html，开发模式加载 vite dev server
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { ScanManager } = require('./scanner');
const { Db } = require('./db');
const { Settings } = require('./settings');
const { Quarantine } = require('./quarantine');
const { registerIpc } = require('./ipc');

// ---------- 单实例锁（防止快速重复启动导致同一任务重复执行） ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

let mainWindow = null;
let services = null;

function isDev() {
  return process.env.NODE_ENV === 'development' || !app.isPackaged;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    frame: false, // 自定义标题栏（渲染进程实现拖拽区与按钮）
    backgroundColor: '#f5f7fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (isDev() && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (isDev()) {
    // 兼容 dev:electron 脚本（wait-on tcp:5173）
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// 窗口控制 IPC（自定义标题栏）
ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());
ipcMain.handle('window:is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // ---------- 初始化服务 ----------
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  const db = new Db(path.join(userData, 'cleandub.db'));
  db.init();
  const settings = new Settings(path.join(userData, 'appsettings.json'));
  const scanManager = new ScanManager({ db });
  const quarantine = new Quarantine({ db, customDir: settings.get().quarantineDir });
  // 隔离区位置变更后实时生效：update-app-settings 时同步更新 quarantine.customDir
  const _origUpdate = settings.update.bind(settings);
  settings.update = (patch) => {
    const r = _origUpdate(patch);
    if (patch && typeof patch.quarantineDir === 'string') {
      quarantine.customDir = patch.quarantineDir.trim() || null;
    }
    return r;
  };
  services = { db, settings, scanManager, quarantine };

  registerIpc({
    ipcMain,
    getWindow: () => mainWindow,
    db,
    settings,
    scanManager,
    quarantine
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 退出前确保运行中的扫描被取消，避免后台遗留文件句柄
  if (services && services.scanManager) services.scanManager.abortIfRunning();
  if (services && services.db) services.db.close();
  if (process.platform !== 'darwin') app.quit();
});
