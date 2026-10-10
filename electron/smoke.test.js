// 冒烟测试：不启动 Electron GUI，直接实例化 Db/ScanManager/Quarantine 验证三段流水线与隔离区格式。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ScanManager } = require('./scanner');
const { Db } = require('./db');
const { Quarantine } = require('./quarantine');

(async () => {
  // ---- 构造测试数据 ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleandub-test-'));
  const root = path.join(tmp, 'scanroot');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, '_dedup_quarantine'), { recursive: true }); // 应被排除
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });      // 应被排除

  const dupContent = Buffer.alloc(100000, 7); // 100KB，重复 3 次
  fs.writeFileSync(path.join(root, 'a.bin'), dupContent);
  fs.writeFileSync(path.join(root, 'sub', 'b.bin'), dupContent);
  fs.writeFileSync(path.join(root, 'sub', 'c.bin'), dupContent);
  fs.writeFileSync(path.join(root, 'unique.bin'), Buffer.alloc(100000, 9)); // 同大小不同内容
  fs.writeFileSync(path.join(root, 'small.bin'), Buffer.alloc(50, 1));      // 唯一大小 → 不哈希
  fs.writeFileSync(path.join(root, 'node_modules', 'x.bin'), dupContent);   // 排除目录 → 不可见
  fs.writeFileSync(path.join(root, '_dedup_quarantine', 'y.bin'), dupContent);

  // ---- 初始化服务 ----
  const db = new Db(path.join(tmp, 'test.db'));
  db.init();
  const scanManager = new ScanManager({ db });
  const events = [];
  scanManager.setEmitter((ch, d) => events.push({ ch, phase: d.phase, state: d.state }));

  // ---- 执行扫描 ----
  const result = await scanManager.startScan([root], {});
  console.log('=== 扫描结果 ===');
  console.log('状态:', result.state, '| 扫描文件数:', result.scannedFileCount, '| 重复组:', result.duplicateGroupCount, '| 重复文件:', result.duplicateFileCount);
  console.log('可释放字节:', result.reclaimableBytes, '(期望 200000 = 100KB * 2 冗余)');
  console.log('组内容:', JSON.stringify(result.groups.map(g => ({ sha: g.sha256.slice(0, 16), files: g.files.map(f => path.basename(f.path)) }))));

  // 验证：三段流水线 → 恰好 1 组，含 a/b/c；unique.bin 同大小不同 hash 应被排除
  const g = result.groups[0];
  const names = g.files.map(f => path.basename(f.path)).sort();
  console.log('断言 1 组 3 文件 a/b/c:', result.groups.length === 1 && names.join() === 'a.bin,b.bin,c.bin' ? 'PASS' : 'FAIL');
  console.log('事件流阶段:', [...new Set(events.map(e => e.phase || e.state))].join(' → '));

  // ---- 重复运行防护 ----
  // (current 已清空，这里验证 isRunning 语义)
  console.log('扫描结束后 isRunning:', scanManager.isRunning() === false ? 'PASS' : 'FAIL');

  // ---- 隔离区 ----
  const q = new Quarantine({ db });
  const qr = await q.moveToQuarantine(root, [
    { path: path.join(root, 'sub', 'b.bin') },
    { path: path.join(root, 'sub', 'c.bin') },
    { path: path.join(root, '..', 'outside.bin') }, // 根外 → 必须拒绝
    { path: path.join(root, 'nonexist.bin') }        // 不存在 → 必须失败
  ]);
  console.log('=== 隔离 ===');
  console.log('moved:', qr.moved, '(期望 2) | failures:', qr.failures.length, '(期望 2)');
  console.log('失败原因:', qr.failures.map(f => f.reason).join(' | '));

  // 验证 manifest.json 格式与 PowerShell 版一致
  const mfPath = path.join(qr.session, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  const e0 = mf.files[0];
  console.log('manifest 字段:', Object.keys(mf).join(','), '/', Object.keys(e0).join(','));
  console.log('session 目录名格式:', /^\d{8}_\d{6}-[0-9a-f]{6}$/.test(path.basename(qr.session)) ? 'PASS' : 'FAIL');
  console.log('manifest 字段格式:', (mf.scanRoot && mf.createdAt && Array.isArray(mf.files) && e0.original && e0.stored && typeof e0.size === 'number' && e0.movedAt) ? 'PASS' : 'FAIL');

  // ---- 还原 ----
  const sessions = await q.loadSessions(root);
  const s0 = sessions[0];
  const rr = await q.restore(root, s0.path, [s0.files[0]]);
  console.log('=== 还原 ===');
  console.log('restored:', rr.restored, '(期望 1) | 剩余文件:', (await q.loadSessions(root))[0]?.fileCount ?? 0, '(期望 1)');
  console.log('b.bin 已回到原处:', fs.existsSync(path.join(root, 'sub', 'b.bin')) ? 'PASS' : 'FAIL');

  // ---- 永久删除 + ops.jsonl ----
  const dr = await q.deletePermanent(root, s0.path, (await q.loadSessions(root))[0].files);
  console.log('=== 删除 ===');
  console.log('deleted:', dr.deleted, '(期望 1) | session 目录已清空删除:', fs.existsSync(s0.path) ? 'FAIL' : 'PASS');
  const opsLog = fs.readFileSync(path.join(root, '_dedup_logs', 'ops.jsonl'), 'utf8').trim().split('\n');
  console.log('ops.jsonl 行数:', opsLog.length, '(期望 3: quarantine/restore/delete)');
  console.log('ops.jsonl 首行 op:', JSON.parse(opsLog[0]).op);

  // ---- 历史持久化 ----
  const hist = db.getScanHistory();
  console.log('=== 历史 ===');
  console.log('历史条数:', hist.length, '| 状态:', hist[0].status, '| roots:', hist[0].roots.length);

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('=== 全部冒烟测试完成 ===');
})().catch(e => { console.error('测试失败:', e); process.exit(1); });
