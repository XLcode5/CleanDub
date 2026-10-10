// 冒烟测试：验证 recurse / detectLinks 扫描选项真实生效（不启动 Electron GUI）。
// 场景：
//   A) recurse=false → 子目录里的重复文件不被发现
//   B) recurse=true  → 子目录里的重复文件被发现（基线）
//   C) detectLinks=false（默认）→ 符号链接文件被跳过
//   D) detectLinks=true → 符号链接被跟随，目标文件被枚举（去重）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ScanManager } = require('./scanner');
const { Db } = require('./db');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleandub-options-'));
  const root = path.join(tmp, 'scanroot');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'linked_dir'), { recursive: true });

  const dup = Buffer.alloc(50000, 7);
  fs.writeFileSync(path.join(root, 'top.bin'), dup);            // 根目录顶层
  fs.writeFileSync(path.join(root, 'sub', 'inner.bin'), dup);   // 子目录副本
  fs.writeFileSync(path.join(root, 'linked_dir', 'target.bin'), dup); // 链接目标

  // 符号链接（Windows 需要管理员/开发者模式；失败则跳过 D 用例）
  let symlinkOk = false;
  try {
    fs.symlinkSync(path.join(root, 'linked_dir', 'target.bin'), path.join(root, 'link.bin'), 'file');
    symlinkOk = true;
  } catch (e) {
    console.log('（跳过符号链接用例：当前环境不允许创建 symlink ——', e.code || e.message, '）');
  }

  const db = new Db(path.join(tmp, 'test.db'));
  db.init();
  const sm = new ScanManager({ db });

  // ---- A) recurse=false：应只看到 top.bin（1 个文件），无重复组 ----
  const rA = await sm.startScan([root], { recurse: false });
  console.log('=== A) recurse=false ===');
  console.log('扫描文件数:', rA.scannedFileCount, '(期望 1: 只有顶层 top.bin)');
  console.log('重复组数:', rA.duplicateGroupCount, '(期望 0)');
  const aPass = rA.scannedFileCount === 1 && rA.duplicateGroupCount === 0;
  console.log('断言 recurse=false 只扫顶层:', aPass ? 'PASS' : 'FAIL');

  // ---- B) recurse=true（默认）：应看到 top/inner/target 3 个文件，1 个重复组 ----
  const rB = await sm.startScan([root], { recurse: true });
  console.log('=== B) recurse=true ===');
  console.log('扫描文件数:', rB.scannedFileCount, '(期望 3)');
  console.log('重复组数:', rB.duplicateGroupCount, '(期望 1)');
  const bPass = rB.scannedFileCount === 3 && rB.duplicateGroupCount === 1;
  console.log('断言 recurse=true 扫描全部:', bPass ? 'PASS' : 'FAIL');

  // ---- C) detectLinks=false（默认）：symlink 不应被枚举 ----
  let cPass = true;
  if (symlinkOk) {
    const rC = await sm.startScan([root], { detectLinks: false });
    console.log('=== C) detectLinks=false ===');
    console.log('扫描文件数:', rC.scannedFileCount, '(期望 3，链接被跳过)');
    cPass = rC.scannedFileCount === 3;
    console.log('断言 detectLinks=false 跳过符号链接:', cPass ? 'PASS' : 'FAIL');
  }

  // ---- D) detectLinks=true：symlink 被跟随，但 realpath 去重使其只算 1 次 ----
  let dPass = true;
  if (symlinkOk) {
    const rD = await sm.startScan([root], { detectLinks: true });
    console.log('=== D) detectLinks=true ===');
    // 现在 top/inner/target 已枚举，再加 link.bin → 共 4 个
    console.log('扫描文件数:', rD.scannedFileCount, '(期望 4: top + inner + target + link)');
    dPass = rD.scannedFileCount === 4;
    console.log('断言 detectLinks=true 跟随符号链接:', dPass ? 'PASS' : 'FAIL');
  }

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const allPass = aPass && bPass && cPass && dPass;
  console.log('=== 扫描选项冒烟测试:', allPass ? '全部 PASS' : '存在 FAIL', '===');
  if (!allPass) process.exit(1);
})().catch(e => { console.error('测试失败:', e); process.exit(1); });
