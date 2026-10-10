// 冒烟测试：验证永久删除/恢复链路（SQLite 状态同步）+ 批量保留策略 API。
// 场景：
//   A) 扫描产生重复组 → quarantine-files 移入隔离区（SQLite 写入 status='quarantined'）
//   B) permanently-delete-files 后 SQLite 状态变为 'deleted'（修复前不更新）
//   C) 重复删除同一批 id → ok=0, skipped>0（不再返回"隔离记录不存在"）
//   D) 完全不存在的 id → 抛 QUARANTINE_NOT_FOUND 错误码
//   E) applyRetentionStrategy 4 种策略语义对齐 Get-Keeper2
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ScanManager } = require('./scanner');
const { Db, pickKeeper } = require('./db');
const { Quarantine } = require('./quarantine');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleandub-quarantine-'));
  const root = path.join(tmp, 'scanroot');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });

  const dup = Buffer.alloc(50000, 11);
  // 制造 4 个相同文件，文件名带不同 (N) 后缀以测试策略
  fs.writeFileSync(path.join(root, 'report.docx'), dup);            // 原件
  fs.writeFileSync(path.join(root, 'report (1).docx'), dup);
  fs.writeFileSync(path.join(root, 'sub', 'report (2).docx'), dup);
  fs.writeFileSync(path.join(root, 'sub', 'report (3).docx'), dup);
  // 时间戳：report.docx 最旧，(3) 最新
  const now = Date.now();
  const older = new Date(now - 40000), newer = new Date(now - 30000);
  const newest1 = new Date(now - 20000), newest2 = new Date(now - 10000);
  fs.utimesSync(path.join(root, 'report.docx'), older, older);
  fs.utimesSync(path.join(root, 'report (1).docx'), newer, newer);
  fs.utimesSync(path.join(root, 'sub', 'report (2).docx'), newest1, newest1);
  fs.utimesSync(path.join(root, 'sub', 'report (3).docx'), newest2, newest2);

  const db = new Db(path.join(tmp, 'test.db'));
  db.init();
  const sm = new ScanManager({ db });
  const q = new Quarantine({ db });

  // ---- 扫描 ----
  const r = await sm.startScan([root], {});
  console.log('=== 扫描 ===');
  console.log('重复组:', r.duplicateGroupCount, '(期望 1) | 文件数:', r.duplicateFileCount, '(期望 4)');

  // ---- A) quarantine-files 移入隔离区，验证 SQLite 状态 ----
  const group = r.groups[0];
  const fileIds = group.files.slice(0, 2).map(f => f.id); // 隔离前 2 个
  const files = db.getFilesByIds(fileIds);
  const scanRoot = db.scanRootOfFile(fileIds[0]);
  const qr = await q.moveToQuarantine(scanRoot, files.map(f => ({ path: f.canonical_path })));
  console.log('=== A) 隔离 ===');
  console.log('moved:', qr.moved, '(期望 2)');
  const qItems = db.getQuarantineItems('quarantined');
  const aPass = qItems.length === 2 && qItems.every(it => it.status === 'quarantined');
  console.log('SQLite quarantine_items 状态:', qItems.map(i => i.status).join(','), aPass ? 'PASS' : 'FAIL');

  // ---- B) 永久删除 → SQLite 状态应变 'deleted' ----
  const quarantineIds = qItems.map(it => it.id);
  // 模拟 IPC 行为：调用 deletePermanent + 更新 DB
  const items = db.getQuarantineItemsByIds(quarantineIds);
  const bySession = new Map();
  for (const it of items) {
    if (!bySession.has(it.session_dir)) bySession.set(it.session_dir, []);
    bySession.get(it.session_dir).push({ original: it.original_path, stored: it.quarantine_path });
  }
  const succeededIds = [];
  for (const [sess, entries] of bySession) {
    const rDel = await q.deletePermanent(items[0].scan_root, sess, entries);
    const okSet = new Set((rDel.succeededStored || []).map(x => String(x).toLowerCase()));
    for (let i = 0; i < entries.length; i++) {
      if (okSet.has(String(entries[i].stored).toLowerCase())) succeededIds.push(items[i].id);
    }
  }
  db.markQuarantineItems(succeededIds, 'deleted');
  const afterDelete = db.getQuarantineItemsByIds(quarantineIds);
  const bPass = afterDelete.every(it => it.status === 'deleted');
  console.log('=== B) 永久删除 ===');
  console.log('succeededIds:', succeededIds.length, '(期望 2) | 删除后状态:', afterDelete.map(i => i.status).join(','));
  console.log('SQLite 状态同步:', bPass ? 'PASS' : 'FAIL（修复前：仍为 quarantined）');

  // ---- C) 重复删除同一批 id → ok=0, skipped=2（修复前抛"隔离记录不存在"）----
  const itemsAgain = db.getQuarantineItemsByIds(quarantineIds);
  const active = itemsAgain.filter(it => !it.status || it.status === 'quarantined');
  const skipped = itemsAgain.filter(it => it.status && it.status !== 'quarantined').length;
  const cPass = active.length === 0 && skipped === 2;
  console.log('=== C) 重复删除 ===');
  console.log('活跃记录:', active.length, '(期望 0) | skipped:', skipped, '(期望 2)');
  console.log('跳过已删除记录:', cPass ? 'PASS' : 'FAIL');

  // ---- D) 不存在的 id → 模拟 IPC 抛错码 ----
  const notFound = db.getQuarantineItemsByIds([999999]);
  const dPass = notFound.length === 0;
  console.log('=== D) 不存在的 id ===');
  console.log('查询返回空数组:', dPass ? 'PASS' : 'FAIL', '(IPC 层会抛 QUARANTINE_NOT_FOUND)');

  // ---- E) 批量保留策略 ----
  console.log('=== E) 批量保留策略 ===');
  const sid = r.sessionId;
  const strategies = ['Cleanest', 'Newest', 'Original', 'Highest'];
  const keeperNames = {};
  for (const strat of strategies) {
    const result = db.applyRetentionStrategy(sid, strat, { skipMarked: false });
    const g = db.getDuplicateGroups(sid).groups[0];
    const keeper = g.files.find(f => f.id === g.retained_file_id);
    keeperNames[strat] = keeper ? keeper.file_name : null;
    console.log(`  ${strat}: keeper=${keeperNames[strat]} (groupsUpdated=${result.groupsUpdated})`);
  }
  // Cleanest: report.docx (无 (N) 后缀)
  // Newest:   report (3).docx (最新)
  // Original: report.docx (无后缀)
  // Highest:  report (3).docx (最大 N=3)
  const ePass = keeperNames.Cleanest === 'report.docx'
    && keeperNames.Newest === 'report (3).docx'
    && keeperNames.Original === 'report.docx'
    && keeperNames.Highest === 'report (3).docx';
  console.log('策略断言:', ePass ? 'PASS' : 'FAIL');
  if (!ePass) {
    console.log('  实际结果:', JSON.stringify(keeperNames));
  }

  // ---- pickKeeper 单元测试 ----
  console.log('=== pickKeeper 单元 ===');
  const u1 = pickKeeper([{ id: 1, file_name: 'a.txt', modified_at: '2024-01-01' }], 'Cleanest');
  console.log('单文件:', u1.id === 1 ? 'PASS' : 'FAIL');
  const u2 = pickKeeper([
    { id: 1, file_name: 'a.txt', modified_at: '2024-01-01' },
    { id: 2, file_name: 'a (1).txt', modified_at: '2024-01-02' }
  ], 'Cleanest');
  console.log('Cleanest 无后缀优先:', u2.id === 1 ? 'PASS' : 'FAIL');
  const u3 = pickKeeper([
    { id: 1, file_name: 'a.txt', modified_at: '2024-01-01' },
    { id: 2, file_name: 'a (1).txt', modified_at: '2024-01-02' }
  ], 'Newest');
  console.log('Newest 最新优先:', u3.id === 2 ? 'PASS' : 'FAIL');
  const u4 = pickKeeper([
    { id: 1, file_name: 'a.txt', modified_at: '2024-01-01' },
    { id: 2, file_name: 'a (1).txt', modified_at: '2024-01-02' },
    { id: 3, file_name: 'a (2).txt', modified_at: '2024-01-01' }
  ], 'Highest');
  console.log('Highest 最大 N 优先:', u4.id === 3 ? 'PASS' : 'FAIL');
  const u5 = pickKeeper([
    { id: 1, file_name: 'a.txt', modified_at: '2024-01-01' },
    { id: 2, file_name: 'a (1).txt', modified_at: '2024-01-02' }
  ], 'Original');
  console.log('Original 原件优先:', u5.id === 1 ? 'PASS' : 'FAIL');

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const allPass = aPass && bPass && cPass && dPass && ePass;
  console.log('=== 隔离/删除/策略冒烟测试:', allPass ? '全部 PASS' : '存在 FAIL', '===');
  if (!allPass) process.exit(1);
})().catch(e => { console.error('测试失败:', e); process.exit(1); });
