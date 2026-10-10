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
      excludeDirs: Array.isArray(p.excludeDirs) ? p.excludeDirs : s.excludeDirs,
      // 参数链打通：payload 优先，缺省回落到 settings（settings 缺省再看 scanner 默认）
      recurse: typeof p.recurse === 'boolean' ? p.recurse : (s.recurse !== false),
      detectLinks: typeof p.detectLinks === 'boolean' ? p.detectLinks : (s.detectLinks === true),
      strategy: typeof p.strategy === 'string' && p.strategy ? p.strategy : s.strategy
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
  // 渲染层期望裸数组（ScanHistoryEntry[]），这里做信封拆包由 handle 统一返回 data
  handle('get-scan-history', () => db.getScanHistory());
  handle('get-duplicate-groups', (p) => db.getDuplicateGroups(p.sessionId || null));
  handle('set-retained-file', (p) => {
    const groupId = Number(p.groupId), fileId = Number(p.fileId);
    if (!Number.isInteger(groupId) || !Number.isInteger(fileId)) throw new Error('参数无效');
    return db.setRetainedFile(groupId, fileId);
  });
  // 批量保留策略：一次性为整个会话的所有重复组选定 retained_file_id
  // strategy: Cleanest / Newest / Original / Highest（对齐 dedup_core.ps1 Get-Keeper2）
  handle('apply-retention-strategy', (p) => {
    const sid = Number.isInteger(p && p.sessionId) ? p.sessionId : null;
    const strategy = (p && typeof p.strategy === 'string' && p.strategy) || settings.get().strategy || 'Cleanest';
    return db.applyRetentionStrategy(sid, strategy);
  });
  handle('delete-scan-history', (p) => {
    const id = Number(p.sessionId);
    if (!Number.isInteger(id)) throw new Error('参数无效');
    return db.deleteScanHistory(id);
  });

  // ---------- 隔离区 ----------
  // 渲染层（CleanupPage/ProfilePage）提交 fileIds（scanned_files.id）或 quarantineIds（quarantine_items.id），
  // 引擎层期望 { scanRoot, files: [{path}] } / { scanRoot, sessionDir, entries }。
  // 适配：由 fileIds 反查 DB 得到 path；由 quarantineIds 反查得到 scanRoot+sessionDir+entries。
  handle('quarantine-files', async (p) => {
    const ids = Array.isArray(p.fileIds) ? p.fileIds.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) throw new Error('没有需要隔离的文件');
    const files = db.getFilesByIds(ids); // [{canonical_path}]
    if (files.length === 0) throw new Error('文件不存在或已被处理');
    const scanRoot = db.scanRootOfFile(ids[0]);
    if (!scanRoot) throw new Error('无法确定扫描根目录');
    const r = await quarantine.moveToQuarantine(scanRoot, files.map(f => ({ path: f.canonical_path })));
    return { ok: r.moved, failed: r.failures.length, skipped: 0 };
  });
  handle('restore-quarantined-files', (p) => {
    const ids = Array.isArray(p.quarantineIds) ? p.quarantineIds.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) throw new Error('没有需要恢复的文件');
    const items = db.getQuarantineItemsByIds(ids);
    if (items.length === 0) {
      const err = new Error('隔离记录不存在（可能已被恢复/删除，或扫描历史已清空）');
      err.code = 'QUARANTINE_NOT_FOUND';
      throw err;
    }
    // 只处理仍处于 quarantined 状态的记录；已 restored/deleted 的跳过
    const activeItems = items.filter(it => !it.status || it.status === 'quarantined');
    const skippedIds = items.filter(it => it.status && it.status !== 'quarantined').map(it => it.id);
    const foundIds = new Set(items.map(it => it.id));
    const missingIds = ids.filter(id => !foundIds.has(id));
    if (activeItems.length === 0) {
      return { ok: 0, failed: 0, skipped: skippedIds.length, missing: missingIds.length, conflicts: [] };
    }
    // 按 session 分组处理（引擎按 session 目录操作）
    let restored = 0, failed = 0;
    const succeededIds = [];
    const bySession = new Map();
    for (const it of activeItems) {
      const key = it.scan_root + '||' + it.session_dir;
      if (!bySession.has(key)) bySession.set(key, { scanRoot: it.scan_root, sess: it.session_dir, entries: [], ids: [] });
      const b = bySession.get(key);
      b.entries.push({ original: it.original_path, stored: it.quarantine_path });
      b.ids.push(it.id);
    }
    return (async () => {
      for (const { scanRoot, sess, entries, ids: sessionIds } of bySession.values()) {
        try {
          const r = await quarantine.restore(scanRoot, sess, entries);
          restored += r.restored; failed += r.failures.length;
          // 用引擎返回的成功 stored 路径反查 DB id，精准标记 restored
          const okSet = new Set((r.succeededStored || []).map(x => String(x).toLowerCase()));
          for (let i = 0; i < entries.length; i++) {
            if (okSet.has(String(entries[i].stored).toLowerCase())) succeededIds.push(sessionIds[i]);
          }
        } catch { failed += entries.length; }
      }
      if (succeededIds.length > 0) {
        try { db.markQuarantineItems(succeededIds, 'restored', { restored_at: new Date().toISOString() }); } catch {}
      }
      return { ok: restored, failed, skipped: skippedIds.length, missing: missingIds.length, conflicts: [] };
    })();
  });
  handle('permanently-delete-files', (p) => {
    const ids = Array.isArray(p.quarantineIds) ? p.quarantineIds.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) throw new Error('没有需要删除的文件');
    const items = db.getQuarantineItemsByIds(ids);
    if (items.length === 0) {
      const err = new Error('隔离记录不存在（可能已被恢复/删除，或扫描历史已清空）');
      err.code = 'QUARANTINE_NOT_FOUND';
      throw err;
    }
    // 已 deleted 的跳过；restored 的不在隔离区，也跳过
    const activeItems = items.filter(it => !it.status || it.status === 'quarantined');
    const skippedIds = items.filter(it => it.status && it.status !== 'quarantined').map(it => it.id);
    const foundIds = new Set(items.map(it => it.id));
    const missingIds = ids.filter(id => !foundIds.has(id));
    if (activeItems.length === 0) {
      return { ok: 0, failed: 0, skipped: skippedIds.length, missing: missingIds.length };
    }
    let deleted = 0, failed = 0;
    const succeededIds = [];
    const bySession = new Map();
    for (const it of activeItems) {
      const key = it.scan_root + '||' + it.session_dir;
      if (!bySession.has(key)) bySession.set(key, { scanRoot: it.scan_root, sess: it.session_dir, entries: [], ids: [] });
      const b = bySession.get(key);
      b.entries.push({ original: it.original_path, stored: it.quarantine_path });
      b.ids.push(it.id);
    }
    return (async () => {
      for (const { scanRoot, sess, entries, ids: sessionIds } of bySession.values()) {
        try {
          const r = await quarantine.deletePermanent(scanRoot, sess, entries);
          deleted += r.deleted; failed += r.failures.length;
          const okSet = new Set((r.succeededStored || []).map(x => String(x).toLowerCase()));
          for (let i = 0; i < entries.length; i++) {
            if (okSet.has(String(entries[i].stored).toLowerCase())) succeededIds.push(sessionIds[i]);
          }
        } catch { failed += entries.length; }
      }
      if (succeededIds.length > 0) {
        try { db.markQuarantineItems(succeededIds, 'deleted'); } catch {}
      }
      return { ok: deleted, failed, skipped: skippedIds.length, missing: missingIds.length };
    })();
  });
  // 渲染层 ProfilePage 不传 scanRoot（读全部隔离记录），改走 SQLite（恢复/删除仍走磁盘 manifest）
  handle('get-quarantine-items', (p) => {
    if (p && typeof p.scanRoot === 'string' && p.scanRoot.trim()) {
      return quarantine.loadSessions(p.scanRoot);
    }
    return db.getQuarantineItems(p && p.status);
  });

  // ---------- 设置与日志 ----------
  handle('get-app-settings', () => settings.get());
  handle('update-app-settings', (p) => settings.update(p));
  handle('get-operation-logs', (p) => db.getOperationLogs(p.limit));

  // ---------- 检查更新（对齐 dedup_server.ps1 Check-UpdateAsync 语义） ----------
  const UPDATE_URL = 'https://api.github.com/repos/XLcode5/CleanDub/releases/latest';
  // 本地版本以 package.json 为准（打包后与安装包版本一致）
  let localVersion = '0.0.0';
  try {
    localVersion = String(require('../package.json').version || '0.0.0');
  } catch { /* dev 环境兜底 */ }

  function compareVersion(local, remote) {
    // 语义对齐 PS 版 Compare-Version：逐段数字比较，返回 1=远程更新 / -1=本地更新 / 0=相同
    const l = String(local).replace(/^v/, '').split('.').map(Number);
    const r = String(remote).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
      const lv = l[i] || 0, rv = r[i] || 0;
      if (rv > lv) return 1;
      if (rv < lv) return -1;
    }
    return 0;
  }

  handle('check-updates', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000); // 10s 超时，对齐 PS 版 TimeoutSec 10
    try {
      const resp = await fetch(UPDATE_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'CleanDub-Updater', 'Accept': 'application/vnd.github+json' }
      });
      if (resp.status === 404) {
        // 仓库尚无任何 Release（新项目常见）——不算错误，如实告知
        return {
          ok: true,
          localVersion,
          latestVersion: '',
          updateAvailable: false,
          downloadUrl: null,
          releaseNotes: '',
          releaseUrl: 'https://github.com/XLcode5/CleanDub/releases',
          checkedAt: new Date().toISOString()
        };
      }
      if (!resp.ok) throw new Error('GitHub API HTTP ' + resp.status);
      const rel = await resp.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      if (!latest) throw new Error('发布标签为空');
      // 找 .exe 安装包资产（对齐 PS 版 $asset.name -match '\.exe$'）
      let downloadUrl = null;
      for (const asset of (rel.assets || [])) {
        if (/\.exe$/i.test(asset.name || '')) { downloadUrl = asset.browser_download_url; break; }
      }
      const cmp = compareVersion(localVersion, latest);
      return {
        ok: true,
        localVersion,
        latestVersion: latest,
        updateAvailable: cmp > 0,
        downloadUrl,
        releaseNotes: String(rel.body || '').slice(0, 2000), // 防超长
        releaseUrl: rel.html_url || '',
        checkedAt: new Date().toISOString()
      };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('检查更新超时（10 秒）');
      throw new Error('检查更新失败: ' + String(e.message || e));
    } finally {
      clearTimeout(timer);
    }
  });

  // 用系统浏览器打开外链（下载页 / 仓库页），不做应用内下载替换
  handle('open-external', async (p) => {
    const url = String(p.url || '');
    if (!/^https:\/\/github\.com\/XLcode5\//i.test(url)) {
      throw new Error('仅允许打开 GitHub 官方发布链接');
    }
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { registerIpc };
