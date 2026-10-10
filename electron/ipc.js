/**
 * IPC 注册 —— 覆盖 docs/cleandub-ui/11-backend-api.md 的全部能力。
 * 每个 handler 统一返回 { ok: true, data } 或 { ok: false, error, code? }，
 * 绝不把原始异常栈泄给渲染进程。
 */
const { dialog } = require('electron');

function ok(data) { return { ok: true, data }; }
function fail(e) {
  return { ok: false, error: String((e && e.message) || e), code: (e && e.code) || undefined };
}

function registerIpc({ ipcMain, getWindow, db, settings, scanManager, quarantine }) {
  // 扫描进度/状态 → 渲染进程事件
  scanManager.setEmitter((channel, data) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  });

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_evt, payload) => {
      try {
        return ok(await fn(payload || {}));
      } catch (e) {
        return fail(e);
      }
    });
  };

  // ---------- 目录选择 ----------
  handle('choose-directories', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      title: '选择扫描目录',
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    });
    if (r.canceled) return { canceled: true, paths: [] };
    return { canceled: false, paths: r.filePaths };
  });

  // ---------- 扫描 ----------
  handle('start-scan', (p) => {
    const roots = Array.isArray(p.roots) ? p.roots : [];
    const s = settings.get();
    const options = {
      minSize: Number.isFinite(p.minSize) ? p.minSize : 1,
      verify: p.verify || s.verify,
      excludeDirs: Array.isArray(p.excludeDirs) ? p.excludeDirs : s.excludeDirs
    };
    // 异步执行，立即返回 sessionId；进度通过 scan-progress 事件推送（长任务不阻塞 UI）
    const promise = scanManager.startScan(roots, options);
    // 把首帧进度（含 sessionId）带回去；完整结果走 scan-state 事件
    return promise.then(
      (result) => ({ sessionId: result.sessionId, result }),
      (e) => { throw e; }
    );
  });

  handle('cancel-scan', () => scanManager.cancel());
  handle('get-scan-progress', () => scanManager.getProgress());

  // ---------- 历史与分组 ----------
  handle('get-scan-history', () => db.getScanHistory());
  handle('get-duplicate-groups', (p) => db.getDuplicateGroups(p.sessionId || null));
  handle('set-retained-file', (p) => {
    const groupId = Number(p.groupId), fileId = Number(p.fileId);
    if (!Number.isInteger(groupId) || !Number.isInteger(fileId)) throw new Error('参数无效');
    return db.setRetainedFile(groupId, fileId);
  });
  handle('delete-scan-history', (p) => {
    const id = Number(p.sessionId);
    if (!Number.isInteger(id)) throw new Error('参数无效');
    return db.deleteScanHistory(id);
  });

  // ---------- 隔离区 ----------
  handle('quarantine-files', (p) => {
    if (typeof p.scanRoot !== 'string' || !p.scanRoot.trim()) throw new Error('缺少扫描根目录');
    const files = Array.isArray(p.files) ? p.files : [];
    return quarantine.moveToQuarantine(p.scanRoot, files);
  });
  handle('restore-quarantined-files', (p) => {
    if (typeof p.scanRoot !== 'string' || typeof p.sessionDir !== 'string') throw new Error('参数无效');
    return quarantine.restore(p.scanRoot, p.sessionDir, Array.isArray(p.entries) ? p.entries : []);
  });
  handle('permanently-delete-files', (p) => {
    if (typeof p.scanRoot !== 'string' || typeof p.sessionDir !== 'string') throw new Error('参数无效');
    return quarantine.deletePermanent(p.scanRoot, p.sessionDir, Array.isArray(p.entries) ? p.entries : []);
  });
  handle('get-quarantine-items', (p) => {
    if (typeof p.scanRoot !== 'string' || !p.scanRoot.trim()) throw new Error('缺少扫描根目录');
    return quarantine.loadSessions(p.scanRoot);
  });

  // ---------- 设置与日志 ----------
  handle('get-app-settings', () => settings.get());
  handle('update-app-settings', (p) => settings.update(p));
  handle('get-operation-logs', (p) => db.getOperationLogs(p.limit));
}

module.exports = { registerIpc };
