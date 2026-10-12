use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

// ============================================================
// 常量
// ============================================================

pub const PREHASH_HEAD_BYTES: u64 = 32768;
pub const HASH_BUFFER_SIZE: usize = 1024 * 1024;

pub const DEFAULT_EXCLUDE_DIRS: &[&str] = &[
    "$RECYCLE.BIN",
    "$Recycle.Bin",
    "System Volume Information",
    ".git",
    "node_modules",
    "_dedup_quarantine",
    "_dedup_logs",
];

const ENUMERATE_PROGRESS_INTERVAL: u64 = 200;
const PREHASH_PROGRESS_INTERVAL: u64 = 100;
const FULLHASH_PROGRESS_INTERVAL: u64 = 50;
const MAX_DEPTH: u32 = 64;

// ============================================================
// 公有类型
// ============================================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    #[serde(default = "default_min_size")]
    pub min_size: u64,
    #[serde(default)]
    pub exclude_dirs: Vec<String>,
    #[serde(default = "default_verify")]
    pub verify: VerifyMode,
    #[serde(default = "default_recurse")]
    pub recurse: bool,
    #[serde(default)]
    pub detect_links: bool,
}

fn default_min_size() -> u64 {
    1
}
fn default_verify() -> VerifyMode {
    VerifyMode::Full
}
fn default_recurse() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum VerifyMode {
    Full,
    Head,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub sha256: String,
    pub file_size: u64,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub scanned_file_count: u64,
    pub error_count: u64,
    pub duplicate_group_count: u64,
    pub duplicate_file_count: u64,
    pub reclaimable_bytes: u64,
    pub groups: Vec<DuplicateGroup>,
    pub duration_ms: f64,
}

pub trait ProgressSink {
    fn on_progress(
        &self,
        phase: &str,
        message: String,
        current: u64,
        total: u64,
        percent: f64,
        elapsed_sec: f64,
    );
    fn is_cancelled(&self) -> bool;
}

#[derive(Debug, thiserror::Error)]
pub enum CleanError {
    #[error("扫描已取消")]
    Cancelled,
    #[error("目录不存在或不可访问: {path}")]
    InvalidRoot { path: String },
    #[error("至少选择一个扫描目录")]
    NoRoots,
    #[error("{path}: {message}")]
    Io { path: String, message: String },
}

// ============================================================
// 内部类型
// ============================================================

#[derive(Debug, Clone)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
    mtime: f64,
}

#[derive(Debug, Clone)]
struct FileInfoWithHash {
    path: String,
    name: String,
    size: u64,
    mtime: f64,
    hash: String,
}

struct ScanContext<'a> {
    opts: &'a ScanOptions,
    exclude_names: HashSet<String>,
    seen_real_paths: HashSet<String>,
    size_groups: HashMap<u64, Vec<FileInfo>>,
    scanned_file_count: u64,
    error_count: u64,
    sink: &'a dyn ProgressSink,
    t0_ms: f64,
}

// ============================================================
// 工具函数
// ============================================================

fn hex_upper(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn elapsed_sec(t0_ms: f64) -> f64 {
    (now_ms() - t0_ms) / 1000.0
}

fn system_time_to_millis(t: std::time::SystemTime) -> f64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// ============================================================
// 流式文件哈希
// ============================================================

/// 读取文件头部 `head_bytes` 字节做 SHA-256，返回大写十六进制。
fn hash_file_head(path: &str, head_bytes: u64) -> Result<String, String> {
    let file =
        File::open(path).map_err(|e| format!("无法打开文件: {e}"))?;
    let mut reader = BufReader::with_capacity(HASH_BUFFER_SIZE, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8192];
    let mut remaining = head_bytes as usize;

    while remaining > 0 {
        let to_read = remaining.min(buf.len());
        let n = reader
            .read(&mut buf[..to_read])
            .map_err(|e| format!("读取文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        remaining -= n;
    }

    Ok(hex_upper(&hasher.finalize()))
}

/// 全量哈希文件，返回大写十六进制。
fn hash_file_full(path: &str) -> Result<String, String> {
    let file =
        File::open(path).map_err(|e| format!("无法打开文件: {e}"))?;
    let mut reader = BufReader::with_capacity(HASH_BUFFER_SIZE, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8192];

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(hex_upper(&hasher.finalize()))
}

// ============================================================
// 枚举阶段
// ============================================================

fn enumerate_dir(dir: &Path, ctx: &mut ScanContext<'_>, depth: u32) -> Result<(), CleanError> {
    if depth > MAX_DEPTH {
        return Ok(());
    }

    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_e) => {
            ctx.error_count += 1;
            return Ok(());
        }
    };

    // 收集子目录，延迟递归避免同时持有 entry 和 ctx 的 borrow
    let mut subdirs: Vec<PathBuf> = Vec::new();

    for entry_result in entries {
        if ctx.sink.is_cancelled() {
            return Err(CleanError::Cancelled);
        }

        let entry = match entry_result {
            Ok(e) => e,
            Err(_e) => {
                ctx.error_count += 1;
                continue;
            }
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_e) => {
                ctx.error_count += 1;
                continue;
            }
        };

        if ft.is_symlink() {
            if !ctx.opts.detect_links {
                // 跳过符号链接
                continue;
            }

            // detect_links = true：解析真实路径，防环去重
            let real_path = match entry.path().canonicalize() {
                Ok(p) => p,
                Err(_e) => {
                    ctx.error_count += 1;
                    continue;
                }
            };

            let real_key = real_path.to_string_lossy().to_lowercase();
            if ctx.seen_real_paths.contains(&real_key) {
                continue;
            }
            ctx.seen_real_paths.insert(real_key);

            let md = match fs::metadata(&real_path) {
                Ok(m) => m,
                Err(_e) => {
                    ctx.error_count += 1;
                    continue;
                }
            };

            if md.is_dir() {
                if ctx.exclude_names.contains(&name) {
                    continue;
                }
                if !ctx.opts.recurse {
                    continue;
                }
                // 递归进入真实目录
                enumerate_dir(&real_path, ctx, depth + 1)?;
            } else if md.is_file() {
                if md.len() < ctx.opts.min_size {
                    continue;
                }
                let mtime = md.modified().map(system_time_to_millis).unwrap_or(0.0);
                ctx.size_groups.entry(md.len()).or_default().push(FileInfo {
                    path: entry.path().to_string_lossy().to_string(),
                    name,
                    size: md.len(),
                    mtime,
                });
                ctx.scanned_file_count += 1;
                maybe_progress_enum(ctx);
            }
        } else if ft.is_dir() {
            if ctx.exclude_names.contains(&name) {
                continue;
            }
            if !ctx.opts.recurse {
                continue;
            }
            subdirs.push(entry.path());
        } else if ft.is_file() {
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_e) => {
                    ctx.error_count += 1;
                    continue;
                }
            };
            if md.len() < ctx.opts.min_size {
                continue;
            }
            let mtime = md.modified().map(system_time_to_millis).unwrap_or(0.0);
            ctx.size_groups.entry(md.len()).or_default().push(FileInfo {
                path: entry.path().to_string_lossy().to_string(),
                name,
                size: md.len(),
                mtime,
            });
            ctx.scanned_file_count += 1;
            maybe_progress_enum(ctx);
        }
        // 其他类型（fifo, socket 等）忽略
    }

    // 延迟递归：已释放所有 entry borrow
    for subdir in subdirs {
        if ctx.sink.is_cancelled() {
            return Err(CleanError::Cancelled);
        }
        enumerate_dir(&subdir, ctx, depth + 1)?;
    }

    Ok(())
}

fn maybe_progress_enum(ctx: &ScanContext<'_>) {
    if ctx.scanned_file_count.is_multiple_of(ENUMERATE_PROGRESS_INTERVAL) {
        ctx.sink.on_progress(
            "enumerate",
            "正在扫描目录结构...".to_string(),
            ctx.scanned_file_count,
            0, // 枚举阶段 total 未知
            0.0,
            elapsed_sec(ctx.t0_ms),
        );
    }
}

// ============================================================
// prehash 阶段
// ============================================================

fn prehash_phase(
    candidates: Vec<FileInfo>,
    ctx: &ScanContext<'_>,
) -> Result<(Vec<FileInfoWithHash>, u64), CleanError> {
    let total = candidates.len() as u64;
    let mut prehash_map: HashMap<String, Vec<FileInfoWithHash>> = HashMap::new();
    let mut error_count: u64 = 0;

    for (i, info) in candidates.into_iter().enumerate() {
        if ctx.sink.is_cancelled() {
            return Err(CleanError::Cancelled);
        }

        match hash_file_head(&info.path, PREHASH_HEAD_BYTES) {
            Ok(head_hash) => {
                let key = format!("{}:{}", info.size, head_hash);
                prehash_map.entry(key).or_default().push(FileInfoWithHash {
                    path: info.path,
                    name: info.name,
                    size: info.size,
                    mtime: info.mtime,
                    hash: head_hash,
                });
            }
            Err(_msg) => {
                error_count += 1;
            }
        }

        // 进度：每 PREHASH_PROGRESS_INTERVAL 个
        let done = (i + 1) as u64;
        if done.is_multiple_of(PREHASH_PROGRESS_INTERVAL) || done == total {
            let percent = if total > 0 {
                (done as f64 * 100.0 / total as f64).min(100.0)
            } else {
                0.0
            };
            ctx.sink.on_progress(
                "prehash",
                "正在预哈希...".to_string(),
                done,
                total,
                percent,
                elapsed_sec(ctx.t0_ms),
            );
        }
    }

    // 只保留 size:headHash 组内文件数 > 1 的
    let survivors: Vec<FileInfoWithHash> = prehash_map
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .flat_map(|(_, v)| v)
        .collect();

    Ok((survivors, error_count))
}

// ============================================================
// fullhash 阶段
// ============================================================

fn fullhash_phase(
    survivors: Vec<FileInfoWithHash>,
    ctx: &ScanContext<'_>,
) -> Result<(HashMap<String, Vec<FileInfoWithHash>>, u64), CleanError> {
    let total = survivors.len() as u64;
    let mut hash_groups: HashMap<String, Vec<FileInfoWithHash>> = HashMap::new();
    let mut error_count: u64 = 0;

    for (i, info) in survivors.into_iter().enumerate() {
        if ctx.sink.is_cancelled() {
            return Err(CleanError::Cancelled);
        }

        let full_hash_result = if ctx.opts.verify == VerifyMode::Head {
            // Head 模式：复用 head_hash，前缀 "HEAD:"
            Ok(format!("HEAD:{}", info.hash))
        } else {
            // Full 模式：全量哈希
            hash_file_full(&info.path)
        };

        match full_hash_result {
            Ok(full_hash) => {
                let key = format!("{}:{}", info.size, full_hash);
                hash_groups.entry(key).or_default().push(info);
            }
            Err(_msg) => {
                error_count += 1;
            }
        }

        // 进度：每 FULLHASH_PROGRESS_INTERVAL 个
        let done = (i + 1) as u64;
        if done.is_multiple_of(FULLHASH_PROGRESS_INTERVAL) || done == total {
            let percent = if total > 0 {
                (done as f64 * 100.0 / total as f64).min(100.0)
            } else {
                0.0
            };
            ctx.sink.on_progress(
                "hash",
                "正在完整哈希...".to_string(),
                done,
                total,
                percent,
                elapsed_sec(ctx.t0_ms),
            );
        }
    }

    Ok((hash_groups, error_count))
}

// ============================================================
// 主入口
// ============================================================

pub fn scan(
    roots: &[String],
    opts: &ScanOptions,
    sink: &dyn ProgressSink,
    t0_ms: f64,
) -> Result<ScanResult, CleanError> {
    // ---- 参数校验 ----
    if roots.is_empty() {
        return Err(CleanError::NoRoots);
    }
    for root in roots {
        let p = Path::new(root);
        if !p.is_dir() {
            return Err(CleanError::InvalidRoot {
                path: root.clone(),
            });
        }
    }

    // ---- 构建排除名集合 ----
    let exclude_names: HashSet<String> = DEFAULT_EXCLUDE_DIRS
        .iter()
        .map(|s| s.to_string())
        .chain(opts.exclude_dirs.iter().cloned())
        .collect();

    let mut ctx = ScanContext {
        opts,
        exclude_names,
        seen_real_paths: HashSet::new(),
        size_groups: HashMap::new(),
        scanned_file_count: 0,
        error_count: 0,
        sink,
        t0_ms,
    };

    // ---- 阶段 1：枚举 ----
    for root in roots {
        enumerate_dir(Path::new(root), &mut ctx, 0)?;
    }

    // 从 size_groups 中取出 >1 的组，扁平化为候选列表（drain 避免 ctx 部分移动，后续阶段仍需借用 ctx）
    let candidates: Vec<FileInfo> = ctx
        .size_groups
        .drain()
        .filter(|(_, v)| v.len() > 1)
        .flat_map(|(_, v)| v)
        .collect();

    // ---- 阶段 2：prehash ----
    let (survivors, pre_errors) = prehash_phase(candidates, &ctx)?;

    // ---- 阶段 3：fullhash ----
    let (hash_groups, fh_errors) = fullhash_phase(survivors, &ctx)?;
    let total_errors = ctx.error_count + pre_errors + fh_errors;

    // ---- 阶段 4：构建结果 ----
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    let mut duplicate_file_count: u64 = 0;
    let mut reclaimable_bytes: u64 = 0;

    for (key, files) in &hash_groups {
        if files.len() >= 2 {
            // key 格式 "size:hash"；Head 模式 "size:HEAD:headHash"，只切第一个冒号
            let sha256 = key.split_once(':').map(|x| x.1).unwrap_or("").to_string();
            let file_size = files[0].size;

            duplicate_file_count += files.len() as u64;
            reclaimable_bytes += file_size * (files.len() as u64 - 1);

            let entries: Vec<FileEntry> = files
                .iter()
                .map(|f| FileEntry {
                    path: f.path.clone(),
                    name: f.name.clone(),
                    size: f.size,
                    mtime: f.mtime,
                })
                .collect();

            groups.push(DuplicateGroup {
                sha256,
                file_size,
                files: entries,
            });
        }
    }

    let duration_ms = now_ms() - t0_ms;

    Ok(ScanResult {
        scanned_file_count: ctx.scanned_file_count,
        error_count: total_errors,
        duplicate_group_count: groups.len() as u64,
        duplicate_file_count,
        reclaimable_bytes,
        groups,
        duration_ms,
    })
}

// ============================================================
// 测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};

    // ---- 测试用 ProgressSink ----

    struct TestSink {
        cancelled: AtomicBool,
    }

    impl TestSink {
        fn new() -> Self {
            Self {
                cancelled: AtomicBool::new(false),
            }
        }
        fn set_cancelled(&self, v: bool) {
            self.cancelled.store(v, Ordering::SeqCst);
        }
    }

    impl ProgressSink for TestSink {
        fn on_progress(
            &self,
            _phase: &str,
            _message: String,
            _current: u64,
            _total: u64,
            _percent: f64,
            _elapsed_sec: f64,
        ) {
            // no-op in tests
        }
        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }
    }

    // ---- 辅助函数 ----

    fn default_opts() -> ScanOptions {
        ScanOptions {
            min_size: 1,
            exclude_dirs: vec![],
            verify: VerifyMode::Full,
            recurse: true,
            detect_links: false,
        }
    }

    fn make_file(dir: &Path, name: &str, content: &[u8]) {
        let path = dir.join(name);
        let mut f = File::create(&path).unwrap();
        f.write_all(content).unwrap();
    }

    // ============================================================
    // 测试用例
    // ============================================================

    #[test]
    fn test_duplicate_detection_two_identical_files() {
        // 两个相同内容的文件 → 1 个重复组
        let dir = std::env::temp_dir().join("scan_core_test_dup");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let content = b"hello world this is duplicate content for testing";
        make_file(&dir, "a.txt", content);
        make_file(&dir, "b.txt", content);

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms()).unwrap();

        assert_eq!(result.scanned_file_count, 2);
        assert_eq!(result.error_count, 0);
        assert_eq!(result.duplicate_group_count, 1);
        assert_eq!(result.duplicate_file_count, 2);
        assert_eq!(result.reclaimable_bytes, content.len() as u64 * 1); // size * (2-1)
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].files.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_size_elimination_different_sizes_no_group() {
        // 不同大小的文件不进同一组
        let dir = std::env::temp_dir().join("scan_core_test_size");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        make_file(&dir, "small.txt", b"aaa");
        make_file(&dir, "large.txt", b"aaaBBB"); // 不同大小

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms()).unwrap();

        assert_eq!(result.scanned_file_count, 2);
        assert_eq!(result.duplicate_group_count, 0);
        assert_eq!(result.groups.len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_min_size_filter() {
        // min_size 过滤：小于 min_size 的文件不计入扫描
        let dir = std::env::temp_dir().join("scan_core_test_minsize");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // 两个相同内容但不同的文件
        make_file(&dir, "tiny.txt", b"x"); // 1 byte
        make_file(&dir, "big.txt", b"hello world!!"); // > 1 byte

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let mut opts = default_opts();
        opts.min_size = 5; // tiny.txt (1 byte) 被过滤

        let result = scan(&roots, &opts, &sink, now_ms()).unwrap();
        assert_eq!(result.scanned_file_count, 1); // 只统计 big.txt

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_exclude_directories_skipped() {
        // 排除目录中的文件不被扫描
        let dir = std::env::temp_dir().join("scan_core_test_exclude");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // 根目录有一个文件
        make_file(&dir, "root_file.txt", b"hello world content here");
        // 排除目录中的文件
        let excluded = dir.join("node_modules");
        fs::create_dir_all(&excluded).unwrap();
        make_file(&excluded, "hidden.txt", b"hello world content here");

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms()).unwrap();

        // node_modules 被默认排除，只统计根目录文件
        assert_eq!(result.scanned_file_count, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_exclude_directories_two_identical_across_boundary() {
        // 排除目录内外的同名内容文件：排除目录内文件不在组中
        let dir = std::env::temp_dir().join("scan_core_test_exclude2");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let content = b"duplicate across boundary test content!!";
        make_file(&dir, "visible.txt", content);

        let excluded = dir.join(".git");
        fs::create_dir_all(&excluded).unwrap();
        make_file(&excluded, "hidden.txt", content);

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms()).unwrap();

        // .git 被默认排除，只有 1 个文件可见 → 无重复组
        assert_eq!(result.scanned_file_count, 1);
        assert_eq!(result.duplicate_group_count, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_cancellation_semantics() {
        // Sink.is_cancelled() 返回 true → 返回 Err(Cancelled)
        let dir = std::env::temp_dir().join("scan_core_test_cancel");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        make_file(&dir, "a.txt", b"some content for cancel test");

        let sink = TestSink::new();
        sink.set_cancelled(true);

        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms());

        match result {
            Err(CleanError::Cancelled) => { /* expected */ }
            other => panic!("Expected Cancelled error, got {:?}", other),
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_no_roots_error() {
        let sink = TestSink::new();
        let result = scan(&[], &default_opts(), &sink, now_ms());
        match result {
            Err(CleanError::NoRoots) => { /* expected */ }
            other => panic!("Expected NoRoots error, got {:?}", other),
        }
    }

    #[test]
    fn test_invalid_root_error() {
        let sink = TestSink::new();
        let roots = vec!["/nonexistent/path/that/does/not/exist_42".to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms());
        match result {
            Err(CleanError::InvalidRoot { .. }) => { /* expected */ }
            other => panic!("Expected InvalidRoot error, got {:?}", other),
        }
    }

    #[test]
    fn test_verify_mode_head() {
        // 小文件（<32KB）：prehash 即全量比较 → 尾部不同必淘汰，0 组（对齐 JS hashFile 语义）
        let dir = std::env::temp_dir().join("scan_core_test_head");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let head = vec![b'A'; 100];
        let mut content1 = head.clone();
        content1.extend_from_slice(b"tail_1_different");
        let mut content2 = head.clone();
        content2.extend_from_slice(b"tail_2_different");

        make_file(&dir, "f1.bin", &content1);
        make_file(&dir, "f2.bin", &content2);

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let mut opts = default_opts();
        opts.verify = VerifyMode::Head;

        let result = scan(&roots, &opts, &sink, now_ms()).unwrap();
        // 头部相同但整文件不同（<32KB prehash=全量）→ 不是重复
        assert_eq!(result.duplicate_group_count, 0, "小文件尾部不同必须淘汰（prehash 全量语义）");

        // 大文件（>32KB）：头部相同尾部不同 → Head 模式视为重复（sha256 带 HEAD: 前缀）
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let big_head = vec![b'B'; 40 * 1024];
        let mut big1 = big_head.clone();
        big1.extend_from_slice(b"tail_1_different");
        let mut big2 = big_head.clone();
        big2.extend_from_slice(b"tail_2_different");
        make_file(&dir, "g1.bin", &big1);
        make_file(&dir, "g2.bin", &big2);

        let result2 = scan(&roots, &opts, &sink, now_ms()).unwrap();
        assert_eq!(result2.duplicate_group_count, 1, "大于 32KB 头部相同 → Head 模式算重复");
        assert_eq!(result2.groups[0].sha256.starts_with("HEAD:"), true);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verify_mode_full_different_content() {
        // Full 模式下，两个文件头部相同但尾部不同 → 不重复
        let dir = std::env::temp_dir().join("scan_core_test_full");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let head = vec![b'A'; 100];
        let mut content1 = head.clone();
        content1.extend_from_slice(b"tail_1_different");
        let mut content2 = head.clone();
        content2.extend_from_slice(b"tail_2_different");

        make_file(&dir, "f1.bin", &content1);
        make_file(&dir, "f2.bin", &content2);

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let opts = default_opts(); // VerifyMode::Full

        let result = scan(&roots, &opts, &sink, now_ms()).unwrap();
        // Full 模式：内容不同 → 不是重复
        assert_eq!(result.duplicate_group_count, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_recurse_false_only_root_files() {
        // recurse=false → 只扫描根目录第一层文件
        let dir = std::env::temp_dir().join("scan_core_test_norecurse");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let content = b"test content for recurse flag";
        make_file(&dir, "root.txt", content);
        let sub = dir.join("subdir");
        fs::create_dir_all(&sub).unwrap();
        make_file(&sub, "child.txt", content);

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let mut opts = default_opts();
        opts.recurse = false;

        let result = scan(&roots, &opts, &sink, now_ms()).unwrap();
        // 只扫描根目录一层
        assert_eq!(result.scanned_file_count, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_empty_directory() {
        let dir = std::env::temp_dir().join("scan_core_test_empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms()).unwrap();

        assert_eq!(result.scanned_file_count, 0);
        assert_eq!(result.duplicate_group_count, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_reclaimable_bytes_calculation() {
        // 3 个相同文件 → reclaimable = size * (3-1) = size * 2
        let dir = std::env::temp_dir().join("scan_core_test_reclaim");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let content = b"calculate reclaimable bytes correctly";
        make_file(&dir, "x.txt", content);
        make_file(&dir, "y.txt", content);
        make_file(&dir, "z.txt", content);

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms()).unwrap();

        assert_eq!(result.duplicate_file_count, 3);
        assert_eq!(result.reclaimable_bytes, content.len() as u64 * 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_multiple_duplicate_groups() {
        // 两组不同的重复文件
        let dir = std::env::temp_dir().join("scan_core_test_multigroups");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let content_a = b"AAAA group A content";
        let content_b = b"BBBB group B content different size";
        make_file(&dir, "a1.txt", content_a);
        make_file(&dir, "a2.txt", content_a);
        make_file(&dir, "b1.txt", content_b);
        make_file(&dir, "b2.txt", content_b);

        let sink = TestSink::new();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = scan(&roots, &default_opts(), &sink, now_ms()).unwrap();

        assert_eq!(result.scanned_file_count, 4);
        assert_eq!(result.duplicate_group_count, 2);
        assert_eq!(result.duplicate_file_count, 4);
        assert_eq!(
            result.reclaimable_bytes,
            (content_a.len() as u64) + (content_b.len() as u64) // each group: size*(2-1)=size
        );

        let _ = fs::remove_dir_all(&dir);
    }
}