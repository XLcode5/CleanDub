// 在 Electron runtime 内验证 better-sqlite3 + DB schema 初始化
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  try {
    const { Db, driver } = require('./db');
    const tmp = path.join(app.getPath('userData'), 'boot-test.db');
    const db = new Db(tmp);
    db.init();
    const id = db.insertScanSession({ started_at: new Date().toISOString(), status: 'running' });
    db.completeScanSession(id, {
      completed_at: new Date().toISOString(), status: 'completed',
      scanned_file_count: 1, duplicate_group_count: 0, duplicate_file_count: 0,
      reclaimable_bytes: 0, duration_ms: 1, error_summary: null
    });
    const hist = db.getScanHistory();
    console.log('SQLITE-BOOT-TEST: driver=' + driver + ' history=' + hist.length + ' status=' + hist[0].status);
    db.close();
    fs.rmSync(tmp, { force: true });
  } catch (e) {
    console.error('SQLITE-BOOT-TEST FAILED:', e.message);
    app.exit(1);
    return;
  }
  app.exit(0);
});
// 不需要窗口
app.on('window-all-closed', () => {});
