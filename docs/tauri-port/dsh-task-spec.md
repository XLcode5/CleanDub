# v1.2.0 Tauri 移植 — DeepSeek 翻译任务规格

> 本文件定义 DeepSeek Harness（zhanlu/deepseek-v4-pro）参与的翻译任务契约。
> 接口签名由 Hermes（仓库管家）统一定义，DeepSeek 产出实现草稿，Hermes 审校/编译/冒烟后集成。

## 硬约束（每个任务 prompt 必带）

1. **接口签名不可改**——函数名/参数/返回类型按本规格执行；需要偏差时在注释中标注，不许静默变更
2. **错误处理**：统一 `thiserror` 定义 `CleanError`；IO 错误带路径上下文
3. **禁止 `unsafe`**（除非标注理由 + SAFETY 注释，Hermes 复核）
4. **隔离区 manifest.json 格式双向兼容**（v1.0.x Electron 版写入的 manifest 必须能被 Rust 版读取，反之亦然）
5. **不引入规格外依赖**；新依赖需在注释里申请理由
6. **每模块附单元测试**，测试用例从现有 JS 冒烟测试对照移植
7. Windows 路径一律 `\\` 处理用 `std::path::PathBuf`；不假设 POSIX

## 模块 API 契约（Hermes 定稿）

### A. scanner（扫描流水线）

```rust
pub struct ScanOptions { pub recursive: bool, pub detect_hardlinks: bool, pub min_size: u64, pub verify: VerifyLevel }
pub enum VerifyLevel { SizeOnly, Prehash, FullSha256 }
pub struct ScanProgress { pub scanned: u64, pub current_path: String, pub phase: ScanPhase }
pub enum ScanPhase { Enumerate, SizeGroup, Prehash, FullHash, Done }
pub struct DuplicateGroup { pub sha256: String, pub size: u64, pub files: Vec<FileEntry> }
pub struct FileEntry { pub path: PathBuf, pub size: u64, pub mtime: i64, pub inode: Option<u64> }

/// 四段流水线：枚举 → 大小分组 → 预哈希(前4KB) → 全量 SHA-256（仅对预哈希相同组）
/// 进度经 tauri::Emitter 上报 "scan-progress" 事件，字段对齐现有 JS 版（见 types.ts ScanProgress）
pub fn scan_directory(roots: &[PathBuf], opts: &ScanOptions, app: &dyn ProgressSink, cancel: &AtomicBool) -> Result<Vec<DuplicateGroup>, CleanError>;
```

### B. quarantine（隔离区，兼容硬约束）

```rust
pub struct QuarantineManifest { pub version: u32, pub items: Vec<QuarantineItem> }
pub struct QuarantineItem { pub original: String, pub stored: String, pub size: u64, pub moved_at: String }

/// 迁移语义与 JS 版完全一致：movedAt 字段名（camelCase）在 JSON 中保持不变
pub fn quarantine_files(root: &Path, files: &[FileEntry], qroot: &Path) -> Result<QuarantineReport, CleanError>;
pub fn restore_items(root: &Path, stored_paths: &[String]) -> Result<RestoreReport, CleanError>;
pub fn delete_permanent(root: &Path, stored_paths: &[String]) -> Result<DeleteReport, CleanError>;
pub fn delete_scan_files(root: &Path, paths: &[PathBuf]) -> Result<DeleteReport, CleanError>;  // v1.0.2 直删通道
```

### C. strategies（保留策略）

```rust
pub enum RetainStrategy { NewestMtime, ShortestName, LongestName, OriginalFirst, CleanestName }
/// OriginalFirst: 路径含 "copy|副本|备份|backup|old|原" 字样者降权；CleanestName: 最少干扰字符
pub fn pick_retained(group: &[FileEntry], strategy: RetainStrategy) -> Result<FileEntry, CleanError>;
```

### D. db（rusqlite）

schema 与现有 SQLite 完全一致（表名/列名不改）——老用户 `cleandub.db` 直接可用。
初始化逻辑含 `PRAGMA journal_mode=WAL`。

## 任务分派格式（dsh headless 实际调用模板）

```
任务：把以下 JS 引擎模块翻译成 Rust。
约束：<本文件"硬约束"段全文>
接口签名：<上述对应模块签名>
JS 参考实现：<贴 scanner.js / quarantine.js / strategies.js 完整源码>
行为验收：<对应 JS 冒烟测试断言清单>
输出：单个 Rust 代码块，含 #[cfg(test)] 单元测试。不要解释。
```

## 验收流水线（Hermes 执行）

1. `cargo clippy -- -D warnings` 零警告
2. `cargo test` 单元测试全过
3. 移植冒烟测试：与 JS 版同输入 → 同输出（逐字段 JSON diff）
4. 集成后 CDP 全链路回归（扫描→保留→反选→直删/隔离）
