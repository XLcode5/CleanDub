use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;
use serde::{Deserialize, Serialize};

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CleanError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Other(String),
}

impl From<&str> for CleanError {
    fn from(s: &str) -> Self {
        CleanError::Other(s.to_string())
    }
}

impl From<String> for CleanError {
    fn from(s: String) -> Self {
        CleanError::Other(s)
    }
}

// ─── Public data types ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FileRef {
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineReport {
    pub session: String,
    pub moved: u64,
    pub bytes: u64,
    pub failures: Vec<FailEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailEntry {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: u64,
    pub bytes: u64,
    pub failures: Vec<FailEntry>,
    pub succeeded_stored: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub deleted: u64,
    pub bytes: u64,
    pub failures: Vec<FailEntry>,
    pub succeeded_stored: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineItem {
    pub original: String,
    pub stored: String,
    pub size: u64,
    #[serde(rename = "movedAt")]
    pub moved_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub files: Vec<QuarantineItem>,
    pub file_count: usize,
    pub bytes: u64,
}

// ─── Internal (de)serialization helpers ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestDoc {
    scan_root: String,
    created_at: String,
    files: Vec<QuarantineItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpsLogEntry {
    op: String,
    ts: String,
    root: String,
    session: String,
    moved: u64,
    bytes: u64,
    #[serde(rename = "failedCount")]
    failed_count: u64,
    detail: String,
}

// ─── Public struct ───────────────────────────────────────────────────────────

pub struct QuarantineCore {
    pub custom_dir: Option<String>,
}

impl QuarantineCore {
    pub fn new(custom_dir: Option<String>) -> Self {
        QuarantineCore { custom_dir }
    }

    pub fn quarantine_root(&self, scan_root: &str) -> String {
        let root = normalize_root_str(scan_root);
        if let Some(ref cd) = self.custom_dir {
            cd.clone()
        } else {
            format!("{}{}_dedup_quarantine", root, std::path::MAIN_SEPARATOR)
        }
    }

    pub fn logs_root(&self, scan_root: &str) -> String {
        let root = normalize_root_str(scan_root);
        format!("{}{}_dedup_logs", root, std::path::MAIN_SEPARATOR)
    }

    // ── quarantine_files ─────────────────────────────────────────────────

    pub fn quarantine_files(
        &self,
        scan_root: &str,
        files: &[FileRef],
    ) -> Result<QuarantineReport, CleanError> {
        let root = normalize_root(scan_root);
        let qroot = PathBuf::from(self.quarantine_root(scan_root));
        let lroot = PathBuf::from(self.logs_root(scan_root));

        let session_dir_name = session_dir_name();
        let session = qroot.join(&session_dir_name);

        let mut entries: Vec<QuarantineItem> = Vec::new();
        let mut moved: u64 = 0;
        let mut bytes: u64 = 0;
        let mut failures: Vec<FailEntry> = Vec::new();

        for fr in files {
            let full = match resolve_path(Path::new(&fr.path)) {
                Ok(p) => p,
                Err(_) => {
                    failures.push(FailEntry {
                        path: fr.path.clone(),
                        reason: "无法解析文件路径".to_string(),
                    });
                    continue;
                }
            };

            // 不在扫描根内 → 拒绝
            if !is_under(&full, &root) {
                failures.push(FailEntry {
                    path: fr.path.clone(),
                    reason: "文件不在扫描根目录内，已拒绝移入隔离区".to_string(),
                });
                continue;
            }

            // 在隔离区/日志区内 → 拒绝
            if is_under(&full, &qroot) || is_under(&full, &lroot) {
                failures.push(FailEntry {
                    path: fr.path.clone(),
                    reason: "文件属于隔离区或日志区，已拒绝移入".to_string(),
                });
                continue;
            }

            // stat 复查
            let meta = match fs::symlink_metadata(&full) {
                Ok(m) => m,
                Err(_) => {
                    failures.push(FailEntry {
                        path: fr.path.clone(),
                        reason: "文件不存在（可能已被处理）".to_string(),
                    });
                    continue;
                }
            };
            let size = meta.len();

            // 计算相对路径（对根）
            let rel = full
                .strip_prefix(&root)
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|_| {
                    full.file_name()
                        .map(PathBuf::from)
                        .unwrap_or_else(|| PathBuf::from("unknown"))
                });

            let dest = unique_path(&session.join(&rel));

            // mkdir -p 目标父目录
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }

            // 移动
            match move_with_fallback(&full, &dest, Some(size)) {
                Ok(()) => {
                    entries.push(QuarantineItem {
                        original: full.to_string_lossy().to_string(),
                        stored: dest.to_string_lossy().to_string(),
                        size,
                        moved_at: iso_now(),
                    });
                    moved += 1;
                    bytes += size;
                }
                Err(e) => {
                    failures.push(FailEntry {
                        path: fr.path.clone(),
                        reason: e.to_string(),
                    });
                }
            }
        }

        // 有成功条目则写 manifest
        if !entries.is_empty() {
            fs::create_dir_all(&session)?;
            let manifest = ManifestDoc {
                scan_root: root.to_string_lossy().to_string(),
                created_at: iso_now(),
                files: entries.clone(),
            };
            let json = serde_json::to_string(&manifest).unwrap();
            // 确保无 BOM
            let manifest_path = session.join("manifest.json");
            fs::write(&manifest_path, json.as_bytes())?;
        }

        // append ops log
        let _ = append_op_log(&OpsLogEntry {
            op: "quarantine".to_string(),
            ts: iso_now(),
            root: root.to_string_lossy().to_string(),
            session: session.to_string_lossy().to_string(),
            moved,
            bytes,
            failed_count: failures.len() as u64,
            detail: format!(
                "移入隔离区 {} 个 / {} B，失败 {}",
                moved,
                bytes,
                failures.len()
            ),
        });

        Ok(QuarantineReport {
            session: session.to_string_lossy().to_string(),
            moved,
            bytes,
            failures,
        })
    }

    // ── load_sessions ────────────────────────────────────────────────────

    pub fn load_sessions(&self, scan_root: &str) -> Vec<SessionInfo> {
        let qroot = PathBuf::from(self.quarantine_root(scan_root));
        if !qroot.exists() || !qroot.is_dir() {
            return Vec::new();
        }

        let mut sessions: Vec<SessionInfo> = Vec::new();

        let readdir = match fs::read_dir(&qroot) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        for entry in readdir.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("manifest.json");
            let json_bytes = match fs::read(&manifest_path) {
                Ok(b) => b,
                Err(_) => continue, // 损坏 session 跳过
            };

            let doc: ManifestDoc = match serde_json::from_slice(&json_bytes) {
                Ok(d) => d,
                Err(_) => continue, // 解析失败跳过
            };

            let files: Vec<QuarantineItem> = doc
                .files
                .into_iter()
                .filter(|f| !f.stored.is_empty())
                .map(|f| QuarantineItem {
                    original: f.original,
                    stored: f.stored,
                    size: f.size,
                    moved_at: f.moved_at,
                })
                .collect();

            let file_count = files.len();
            let bytes: u64 = files.iter().map(|f| f.size).sum();

            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            sessions.push(SessionInfo {
                name,
                path: path.to_string_lossy().to_string(),
                created_at: doc.created_at,
                files,
                file_count,
                bytes,
            });
        }

        // 按 createdAt 降序
        sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        sessions
    }

    // ── restore ──────────────────────────────────────────────────────────

    pub fn restore(
        &self,
        scan_root: &str,
        session_dir: &str,
        entries: &[QuarantineItem],
    ) -> Result<RestoreReport, CleanError> {
        let root = normalize_root(scan_root);
        let qroot = PathBuf::from(self.quarantine_root(scan_root));

        let sess_full = resolve_path(Path::new(session_dir))?;

        // 安全校验：session_dir 的父目录必须是 qroot
        {
            let parent = sess_full
                .parent()
                .ok_or_else(|| CleanError::Other("隔离会话路径非法".to_string()))?;
            let qroot_resolved = resolve_path(&qroot)?;
            if parent.to_string_lossy().to_lowercase()
                != qroot_resolved.to_string_lossy().to_lowercase()
            {
                return Err(CleanError::Other("隔离会话路径非法".to_string()));
            }
        }

        let mut restored: u64 = 0;
        let mut bytes: u64 = 0;
        let mut failures: Vec<FailEntry> = Vec::new();
        let mut succeeded_stored: Vec<String> = Vec::new();

        for entry in entries {
            let stored_full = match resolve_path(Path::new(&entry.stored)) {
                Ok(p) => p,
                Err(_) => {
                    failures.push(FailEntry {
                        path: entry.stored.clone(),
                        reason: "无法解析隔离文件路径".to_string(),
                    });
                    continue;
                }
            };

            // stored 必须在 session 目录内
            if !is_under(&stored_full, &sess_full) {
                failures.push(FailEntry {
                    path: entry.stored.clone(),
                    reason: "不在隔离区内，已拒绝还原".to_string(),
                });
                continue;
            }

            // stored 必须存在
            if fs::metadata(&stored_full).is_err() {
                failures.push(FailEntry {
                    path: entry.stored.clone(),
                    reason: "隔离区内文件已不存在".to_string(),
                });
                continue;
            }

            // 计算目标路径
            let mut target = resolve_path(Path::new(&entry.original)).unwrap_or_else(|_| {
                PathBuf::from(&entry.original)
            });

            // 目标已存在 → 加 .restored 后缀
            if target.exists() {
                let mut alt = target.clone();
                let alt_name = format!(
                    "{}.restored",
                    alt.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                );
                alt.set_file_name(&alt_name);
                target = alt;
            }

            // mkdir -p 目标父目录
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }

            // 移动
            match move_with_fallback(&stored_full, &target, None) {
                Ok(()) => {
                    restored += 1;
                    bytes += entry.size;
                    succeeded_stored.push(stored_full.to_string_lossy().to_string());
                }
                Err(e) => {
                    failures.push(FailEntry {
                        path: entry.stored.clone(),
                        reason: e.to_string(),
                    });
                }
            }
        }

        // 回写 manifest
        rewrite_manifest(
            &sess_full,
            &succeeded_stored
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<&str>>(),
        );

        // append ops log
        let _ = append_op_log(&OpsLogEntry {
            op: "quarantine-restore".to_string(),
            ts: iso_now(),
            root: root.to_string_lossy().to_string(),
            session: sess_full.to_string_lossy().to_string(),
            moved: restored,
            bytes,
            failed_count: failures.len() as u64,
            detail: format!("还原 {} 个，失败 {}", restored, failures.len()),
        });

        Ok(RestoreReport {
            restored,
            bytes,
            failures,
            succeeded_stored: succeeded_stored
                .iter()
                .map(|s| s.to_string())
                .collect(),
        })
    }

    // ── delete_permanent ─────────────────────────────────────────────────

    pub fn delete_permanent(
        &self,
        scan_root: &str,
        session_dir: &str,
        entries: &[QuarantineItem],
    ) -> Result<DeleteReport, CleanError> {
        let root = normalize_root(scan_root);
        let qroot = PathBuf::from(self.quarantine_root(scan_root));

        let sess_full = resolve_path(Path::new(session_dir))?;

        // 安全校验
        {
            let parent = sess_full
                .parent()
                .ok_or_else(|| CleanError::Other("隔离会话路径非法".to_string()))?;
            let qroot_resolved = resolve_path(&qroot)?;
            if parent.to_string_lossy().to_lowercase()
                != qroot_resolved.to_string_lossy().to_lowercase()
            {
                return Err(CleanError::Other("隔离会话路径非法".to_string()));
            }
        }

        let mut deleted: u64 = 0;
        let mut bytes: u64 = 0;
        let mut failures: Vec<FailEntry> = Vec::new();
        let mut succeeded_stored: Vec<String> = Vec::new();

        for entry in entries {
            let stored_full = match resolve_path(Path::new(&entry.stored)) {
                Ok(p) => p,
                Err(_) => {
                    failures.push(FailEntry {
                        path: entry.stored.clone(),
                        reason: "无法解析隔离文件路径".to_string(),
                    });
                    continue;
                }
            };

            if !is_under(&stored_full, &sess_full) {
                failures.push(FailEntry {
                    path: entry.stored.clone(),
                    reason: "不在隔离区内，已拒绝删除".to_string(),
                });
                continue;
            }

            match fs::remove_file(&stored_full) {
                Ok(()) => {
                    deleted += 1;
                    bytes += entry.size;
                    succeeded_stored.push(stored_full.to_string_lossy().to_string());
                }
                Err(e) => {
                    failures.push(FailEntry {
                        path: entry.stored.clone(),
                        reason: format!("删除失败: {}", e),
                    });
                }
            }
        }

        // 回写 manifest
        rewrite_manifest(
            &sess_full,
            &succeeded_stored
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<&str>>(),
        );

        let _ = append_op_log(&OpsLogEntry {
            op: "quarantine-delete".to_string(),
            ts: iso_now(),
            root: root.to_string_lossy().to_string(),
            session: sess_full.to_string_lossy().to_string(),
            moved: deleted,
            bytes,
            failed_count: failures.len() as u64,
            detail: format!("永久删除 {} 个，失败 {}", deleted, failures.len()),
        });

        Ok(DeleteReport {
            deleted,
            bytes,
            failures,
            succeeded_stored: succeeded_stored
                .iter()
                .map(|s| s.to_string())
                .collect(),
        })
    }

    // ── delete_scan_files (v1.0.2 直删通道) ─────────────────────────────

    pub fn delete_scan_files(
        &self,
        scan_root: &str,
        paths: &[String],
    ) -> Result<DeleteReport, CleanError> {
        let root = normalize_root(scan_root);
        let qroot = PathBuf::from(self.quarantine_root(scan_root));
        let lroot = PathBuf::from(self.logs_root(scan_root));

        if paths.is_empty() {
            return Err(CleanError::Other("没有需要删除的文件".to_string()));
        }

        let mut deleted: u64 = 0;
        let mut bytes: u64 = 0;
        let mut failures: Vec<FailEntry> = Vec::new();
        let mut succeeded_stored: Vec<String> = Vec::new();

        for path_str in paths {
            let full = match resolve_path(Path::new(path_str)) {
                Ok(p) => p,
                Err(_) => {
                    failures.push(FailEntry {
                        path: path_str.clone(),
                        reason: "无法解析文件路径".to_string(),
                    });
                    continue;
                }
            };

            // 必须在扫描根内
            if !is_under(&full, &root) {
                failures.push(FailEntry {
                    path: path_str.clone(),
                    reason: "文件不在扫描根目录内，已拒绝删除".to_string(),
                });
                continue;
            }

            // 拒绝隔离区/日志区文件
            if is_under(&full, &qroot) || is_under(&full, &lroot) {
                failures.push(FailEntry {
                    path: path_str.clone(),
                    reason: "文件属于隔离区或日志区，已拒绝删除".to_string(),
                });
                continue;
            }

            // stat 复查
            let meta = match fs::symlink_metadata(&full) {
                Ok(m) => m,
                Err(_) => {
                    failures.push(FailEntry {
                        path: path_str.clone(),
                        reason: "文件不存在（可能已被处理）".to_string(),
                    });
                    continue;
                }
            };
            let size = meta.len();

            match fs::remove_file(&full) {
                Ok(()) => {
                    deleted += 1;
                    bytes += size;
                    succeeded_stored.push(full.to_string_lossy().to_string());
                }
                Err(e) => {
                    failures.push(FailEntry {
                        path: path_str.clone(),
                        reason: format!("删除失败: {}", e),
                    });
                }
            }
        }

        let _ = append_op_log(&OpsLogEntry {
            op: "scan-delete".to_string(),
            ts: iso_now(),
            root: root.to_string_lossy().to_string(),
            session: String::new(),
            moved: deleted,
            bytes,
            failed_count: failures.len() as u64,
            detail: format!(
                "直接永久删除 {} 个 / {} B，失败 {}",
                deleted,
                bytes,
                failures.len()
            ),
        });

        Ok(DeleteReport {
            deleted,
            bytes,
            failures,
            succeeded_stored,
        })
    }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/// trim + 去尾部斜杠/反斜杠 + 解析为绝对路径（若存在则 canonicalize）
fn normalize_root(s: &str) -> PathBuf {
    let trimmed = s.trim().trim_end_matches(['/', '\\']);
    let p = Path::new(trimmed);
    resolve_path(p).unwrap_or_else(|_| p.to_path_buf())
}

fn normalize_root_str(s: &str) -> String {
    normalize_root(s).to_string_lossy().to_string()
}

/// 将路径解析为绝对路径。优先使用 `canonicalize`（要求路径存在），
/// 若路径不存在则退化为手动拼接当前工作目录并清理 `.` / `..`。
fn resolve_path(path: &Path) -> Result<PathBuf, io::Error> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    match abs.canonicalize() {
        Ok(canon) => Ok(strip_verbatim_prefix(&canon)),
        Err(_) => {
            // 手动清理
            let mut components: Vec<std::path::Component<'_>> = Vec::new();
            for comp in abs.components() {
                match comp {
                    std::path::Component::CurDir => continue,
                    std::path::Component::ParentDir => {
                        components.pop();
                    }
                    c => components.push(c),
                }
            }
            let cleaned: PathBuf = components.into_iter().collect();
            // 若仍不是绝对路径，拼回 cwd
            if cleaned.is_absolute() {
                Ok(cleaned)
            } else {
                Ok(std::env::current_dir()?.join(&cleaned))
            }
        }
    }
}

/// 去掉 Windows `\\?\` 前缀使路径与 JS 版 `path.resolve` 一致
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix("\\\\?\\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

/// 检查 child 是否在 parent 下（大小写不敏感、要求 parent 以分隔符结尾比对）
fn is_under(child: &Path, parent: &Path) -> bool {
    let child_str = child.to_string_lossy().to_lowercase();
    let parent_str = parent.to_string_lossy().to_lowercase();
    // 确保 parent 后有分隔符
    let prefix = if parent_str.ends_with(std::path::MAIN_SEPARATOR) {
        parent_str
    } else {
        format!("{}{}", parent_str, std::path::MAIN_SEPARATOR)
    };
    child_str.starts_with(&prefix)
}

/// 唯一路径：dest 若存在 → dest.1、dest.2 … 递增
fn unique_path(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let file_name = dest.file_name().unwrap_or_default().to_string_lossy();
    let mut i: u32 = 1;
    loop {
        let candidate = parent.join(format!("{}.{}", file_name, i));
        if !candidate.exists() {
            return candidate;
        }
        i = i.saturating_add(1);
    }
}

// ─── File ops ────────────────────────────────────────────────────────────────

/// 跨设备/占用安全移动：先 rename；失败则 copy + 双 stat 校验 → 删源。
/// `expected_size` 为 `Some(n)` 时会同时校验目标大小，为 `None` 时仅校验源与目标一致。
fn move_with_fallback(
    src: &Path,
    dest: &Path,
    expected_size: Option<u64>,
) -> Result<(), CleanError> {
    match fs::rename(src, dest) {
        Ok(()) => return Ok(()),
        Err(_) => { /* fall through to copy */ }
    }

    // fallback: copy
    fs::copy(src, dest)?;

    // 双 stat 校验
    let s1 = fs::metadata(src)?;
    let s2 = fs::metadata(dest)?;

    let size_ok = s1.len() == s2.len()
        && match expected_size {
            Some(exp) => s2.len() == exp,
            None => true,
        };

    if !size_ok {
        // 删半成品，不删源
        let _ = fs::remove_file(dest);
        return Err(CleanError::Other(
            "跨磁盘复制校验失败，已保留原文件".to_string(),
        ));
    }

    // 校验通过，删源
    fs::remove_file(src)?;
    Ok(())
}

// ─── Manifest helpers ────────────────────────────────────────────────────────

/// 读取 manifest，过滤掉 removed 的 stored 条目；剩 0 条则递归删除整个 session 目录；
/// 否则覆写 manifest。
fn rewrite_manifest(sess_full: &Path, removed_stored: &[&str]) {
    let manifest_path = sess_full.join("manifest.json");
    let json_bytes = match fs::read(&manifest_path) {
        Ok(b) => b,
        Err(_) => return,
    };

    let mut doc: ManifestDoc = match serde_json::from_slice(&json_bytes) {
        Ok(d) => d,
        Err(_) => return,
    };

    let removed_lower: Vec<String> = removed_stored
        .iter()
        .filter_map(|s| resolve_path(Path::new(s)).ok())
        .map(|p| p.to_string_lossy().to_lowercase())
        .collect();

    let remaining: Vec<QuarantineItem> = doc
        .files
        .into_iter()
        .filter(|f| {
            if f.stored.is_empty() {
                return false;
            }
            let resolved = resolve_path(Path::new(&f.stored))
                .map(|p| p.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| f.stored.to_lowercase());
            !removed_lower.contains(&resolved)
        })
        .collect();

    if remaining.is_empty() {
        // 递归删除整个 session 目录
        let _ = fs::remove_dir_all(sess_full);
        return;
    }

    doc.files = remaining;
    let json = serde_json::to_string(&doc).unwrap();
    let _ = fs::write(&manifest_path, json.as_bytes());
}

// ─── Ops log ─────────────────────────────────────────────────────────────────

fn append_op_log(entry: &OpsLogEntry) -> Result<(), CleanError> {
    let root = Path::new(&entry.root);
    let logs_dir = root.join("_dedup_logs");
    fs::create_dir_all(&logs_dir)?;

    let line = serde_json::to_string(entry).unwrap();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("ops.jsonl"))?;
    writeln!(file, "{}", line)?;
    Ok(())
}

// ─── Time / name helpers ─────────────────────────────────────────────────────

/// 本地时间 "yyyy-MM-ddTHH:mm:ss"，无时区后缀
fn iso_now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// "yyyyMMdd_HHmmss-<6 位小写 hex>"
fn session_dir_name() -> String {
    let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let hex = random_hex_6();
    format!("{}-{}", stamp, hex)
}

/// 3 字节随机 hex（6 位小写），无外部随机库 → 基于纳秒 + PID xorshift
fn random_hex_6() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let pid = std::process::id();
    let mut x = (nanos as u64).wrapping_mul(6364136223846793005);
    x ^= (pid as u64).wrapping_mul(1442695040888963407);
    x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51AFD7ED558CCD);
    x ^= x >> 33;
    let b = x.to_le_bytes();
    format!("{:02x}{:02x}{:02x}", b[0], b[1], b[2])
}

// ══════════════════════════════════════════════════════════════════════════════
//  Unit tests
// ══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 构造临时目录并返回其路径（test 结束时自动清理）
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qcore_test_{}_{}",
            std::process::id(),
            random_hex_6()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在 `root` 下创建文件，返回完整路径与文件大小
    fn touch(root: &Path, name: &str) -> (PathBuf, u64) {
        let full = root.join(name);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let content = format!("content of {} at {:?}", name, std::time::Instant::now());
        fs::write(&full, content.as_bytes()).unwrap();
        let size = fs::metadata(&full).unwrap().len();
        (full, size)
    }

    // ─── 测试 1: quarantine → load_sessions 读回一致 ──────────────────────

    #[test]
    fn test_quarantine_load_roundtrip() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (fpath, fsize) = touch(&root, "test_file.txt");

        let files = vec![FileRef {
            path: fpath.to_string_lossy().to_string(),
        }];

        let report = core.quarantine_files(&root.to_string_lossy().to_string(), &files).unwrap();
        assert_eq!(report.moved, 1);
        assert_eq!(report.bytes, fsize);
        assert!(report.failures.is_empty());

        // 原文件已被移走
        assert!(!fpath.exists());

        let sessions = core.load_sessions(&root.to_string_lossy().to_string());
        assert_eq!(sessions.len(), 1);
        let sess = &sessions[0];
        assert_eq!(sess.file_count, 1);
        assert_eq!(sess.bytes, fsize);
        assert_eq!(sess.files.len(), 1);

        let item = &sess.files[0];
        assert_eq!(item.original, fpath.to_string_lossy().to_string());
        assert_eq!(item.size, fsize);
        assert!(!item.stored.is_empty());
        assert!(!item.moved_at.is_empty());

        // camelCase 断言：解析后的字段名应在结构中
        let manifest_path = PathBuf::from(&sess.path).join("manifest.json");
        let raw = fs::read_to_string(&manifest_path).unwrap();
        assert!(raw.contains("\"scanRoot\""));
        assert!(raw.contains("\"createdAt\""));
        assert!(raw.contains("\"movedAt\""));
        assert!(!raw.contains("scan_root"));
        assert!(!raw.contains("created_at"));
    }

    // ─── 测试 2: 根外文件拒绝、隔离区/日志区文件拒绝 ──────────────────────

    #[test]
    fn test_reject_out_of_root_and_protected_zones() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (inside, isize) = touch(&root, "inside.txt");
        let outside_dir = temp_dir(); // 另一个临时目录
        let outside = outside_dir.join("outside.txt");
        fs::write(&outside, b"outside").unwrap();

        // 在隔离区里放一个文件
        let qroot = PathBuf::from(core.quarantine_root(&root.to_string_lossy().to_string()));
        fs::create_dir_all(&qroot).unwrap();
        let qfile = qroot.join("already_quarantined.txt");
        fs::write(&qfile, b"quarantined").unwrap();

        // 在日志区里放一个文件
        let lroot = PathBuf::from(core.logs_root(&root.to_string_lossy().to_string()));
        fs::create_dir_all(&lroot).unwrap();
        let lfile = lroot.join("logfile.txt");
        fs::write(&lfile, b"logdata").unwrap();

        let files = vec![
            FileRef { path: inside.to_string_lossy().to_string() },
            FileRef { path: outside.to_string_lossy().to_string() },
            FileRef { path: qfile.to_string_lossy().to_string() },
            FileRef { path: lfile.to_string_lossy().to_string() },
        ];

        let report = core.quarantine_files(&root.to_string_lossy().to_string(), &files).unwrap();
        assert_eq!(report.moved, 1);
        assert_eq!(report.bytes, isize);
        assert_eq!(report.failures.len(), 3);

        let reasons: Vec<&str> = report.failures.iter().map(|f| f.reason.as_str()).collect();
        assert!(reasons.iter().any(|r| r.contains("不在扫描根目录内")));
        assert!(reasons.iter().any(|r| r.contains("隔离区或日志区")));
    }

    // ─── 测试 3: restore 后 manifest 剔除成功条目；全空后 session 目录被删 ──

    #[test]
    fn test_restore_removes_from_manifest_and_deletes_empty_session() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (fpath, fsize) = touch(&root, "restore_me.txt");

        let report = core
            .quarantine_files(
                &root.to_string_lossy().to_string(),
                &[FileRef { path: fpath.to_string_lossy().to_string() }],
            )
            .unwrap();
        assert_eq!(report.moved, 1);
        let session_dir = report.session.clone();

        let sessions = core.load_sessions(&root.to_string_lossy().to_string());
        assert_eq!(sessions.len(), 1);
        let items = sessions[0].files.clone();

        // restore
        let rr = core
            .restore(&root.to_string_lossy().to_string(), &session_dir, &items)
            .unwrap();
        assert_eq!(rr.restored, 1);
        assert_eq!(rr.bytes, fsize);

        // 原文件已还原
        assert!(fpath.exists());

        // session 目录应该已被删除（无剩余文件）
        assert!(!PathBuf::from(&session_dir).exists());

        // load_sessions 应返回空
        let sessions2 = core.load_sessions(&root.to_string_lossy().to_string());
        assert!(sessions2.is_empty());
    }

    // ─── 测试 4: restore 目标已存在 → .restored 后缀 ──────────────────────

    #[test]
    fn test_restore_conflict_adds_restored_suffix() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (fpath, _fsize) = touch(&root, "conflict.txt");

        // 隔离
        let report = core
            .quarantine_files(
                &root.to_string_lossy().to_string(),
                &[FileRef { path: fpath.to_string_lossy().to_string() }],
            )
            .unwrap();
        let session_dir = report.session.clone();
        let items = core.load_sessions(&root.to_string_lossy().to_string())[0].files.clone();

        // 在原位置创建一个同名文件
        fs::write(&fpath, b"newer content").unwrap();

        // restore
        let rr = core
            .restore(&root.to_string_lossy().to_string(), &session_dir, &items)
            .unwrap();
        assert_eq!(rr.restored, 1);

        // 原路径仍存在（新内容）
        assert!(fpath.exists());
        assert_eq!(fs::read_to_string(&fpath).unwrap(), "newer content");

        // .restored 文件应存在
        let restored_path = root.join("conflict.txt.restored");
        assert!(restored_path.exists());
    }

    // ─── 测试 5: delete_scan_files 直删成功 + 隔离区文件拒绝 ──────────────

    #[test]
    fn test_delete_scan_files_and_reject_quarantine() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (good, _gsize) = touch(&root, "to_delete.txt");

        // 在隔离区创建一个文件
        let qroot = PathBuf::from(core.quarantine_root(&root.to_string_lossy().to_string()));
        fs::create_dir_all(&qroot).unwrap();
        let qfile = qroot.join("protected.txt");
        fs::write(&qfile, b"do not touch").unwrap();

        let paths: Vec<String> = vec![
            good.to_string_lossy().to_string(),
            qfile.to_string_lossy().to_string(),
        ];

        let report = core.delete_scan_files(&root.to_string_lossy().to_string(), &paths).unwrap();
        assert_eq!(report.deleted, 1);
        assert_eq!(report.failures.len(), 1);
        assert!(report.failures[0].reason.contains("隔离区或日志区"));

        assert!(!good.exists());
        assert!(qfile.exists()); // 隔离区文件未被删除
    }

    // ─── 测试 6: session_dir 路径非法 → Err ───────────────────────────────

    #[test]
    fn test_session_dir_security_rejects_non_child() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        // 构造一个不在 qroot 下的假 session 目录
        let fake_session = temp_dir();
        fs::create_dir_all(&fake_session).unwrap();

        let items = vec![QuarantineItem {
            original: "dummy".to_string(),
            stored: "dummy".to_string(),
            size: 0,
            moved_at: "2024-01-01T00:00:00".to_string(),
        }];

        // restore 应失败
        let rr = core.restore(
            &root.to_string_lossy().to_string(),
            &fake_session.to_string_lossy().to_string(),
            &items,
        );
        assert!(rr.is_err());
        let err_msg = rr.unwrap_err().to_string();
        assert!(err_msg.contains("隔离会话路径非法"));

        // delete_permanent 也应失败
        let dr = core.delete_permanent(
            &root.to_string_lossy().to_string(),
            &fake_session.to_string_lossy().to_string(),
            &items,
        );
        assert!(dr.is_err());
        assert!(dr.unwrap_err().to_string().contains("隔离会话路径非法"));
    }

    // ─── 测试 7: manifest 无 BOM ──────────────────────────────────────────

    #[test]
    fn test_manifest_no_bom() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (fpath, _) = touch(&root, "bom_test.txt");
        let report = core
            .quarantine_files(
                &root.to_string_lossy().to_string(),
                &[FileRef { path: fpath.to_string_lossy().to_string() }],
            )
            .unwrap();

        let sess_dir = PathBuf::from(&report.session);
        let manifest_path = sess_dir.join("manifest.json");
        let raw_bytes = fs::read(&manifest_path).unwrap();

        // 首字节不能是 0xEF（UTF-8 BOM 首字节）
        assert!(!raw_bytes.is_empty());
        assert_ne!(raw_bytes[0], 0xEFu8);
    }

    // ─── 测试 8: restore 时 stored 文件不存在 → failure ───────────────────

    #[test]
    fn test_restore_missing_stored() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (fpath, _) = touch(&root, "will_be_moved.txt");
        let _report = core
            .quarantine_files(
                &root.to_string_lossy().to_string(),
                &[FileRef { path: fpath.to_string_lossy().to_string() }],
            )
            .unwrap();

        let sessions = core.load_sessions(&root.to_string_lossy().to_string());
        let items = sessions[0].files.clone();

        // 手动删除隔离区里的文件
        let stored_path = PathBuf::from(&items[0].stored);
        assert!(stored_path.exists());
        fs::remove_file(&stored_path).unwrap();

        // 尝试 restore
        let rr = core.restore(
            &root.to_string_lossy().to_string(),
            &sessions[0].path,
            &items,
        )
        .unwrap();

        assert_eq!(rr.restored, 0);
        assert_eq!(rr.failures.len(), 1);
        assert!(rr.failures[0].reason.contains("已不存在"));
    }

    // ─── 测试 9: delete_scan_files 空数组 → Err ───────────────────────────

    #[test]
    fn test_delete_scan_files_empty_rejected() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let result = core.delete_scan_files(&root.to_string_lossy().to_string(), &[]);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("没有需要删除的文件"));
    }

    // ─── 测试 10: 多个文件隔离与部分成功 ─────────────────────────────────

    #[test]
    fn test_partial_quarantine() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        let (good1, s1) = touch(&root, "a.txt");
        let (good2, s2) = touch(&root, "b.txt");
        let nonexistent = root.join("ghost.txt"); // 不创建

        let files = vec![
            FileRef { path: good1.to_string_lossy().to_string() },
            FileRef { path: good2.to_string_lossy().to_string() },
            FileRef { path: nonexistent.to_string_lossy().to_string() },
        ];

        let report = core.quarantine_files(&root.to_string_lossy().to_string(), &files).unwrap();
        assert_eq!(report.moved, 2);
        assert_eq!(report.bytes, s1 + s2);
        assert_eq!(report.failures.len(), 1);
        assert!(report.failures[0].reason.contains("不存在"));
    }

    // ─── 测试 11: unique_path 递增行为 ────────────────────────────────────

    #[test]
    fn test_unique_path_increments() {
        let dir = temp_dir();
        let base = dir.join("dup.txt");
        fs::write(&base, b"v0").unwrap();

        let p1 = unique_path(&base);
        assert!(!p1.exists());
        fs::write(&p1, b"v1").unwrap();

        let p2 = unique_path(&base);
        assert!(!p2.exists());
        fs::write(&p2, b"v2").unwrap();

        assert_eq!(p1, dir.join("dup.txt.1"));
        assert_eq!(p2, dir.join("dup.txt.2"));
    }

    // ─── 测试 12: load_sessions 降序排序 ──────────────────────────────────

    #[test]
    fn test_load_sessions_sorted_desc() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        // 创建两个隔离批次
        let (f1, _) = touch(&root, "first.txt");
        let report1 = core
            .quarantine_files(
                &root.to_string_lossy().to_string(),
                &[FileRef { path: f1.to_string_lossy().to_string() }],
            )
            .unwrap();

        // 短暂等待确保时间戳不同
        std::thread::sleep(std::time::Duration::from_millis(1100));

        // 再创建文件并隔离
        let (f2, _) = touch(&root, "second.txt");
        let report2 = core
            .quarantine_files(
                &root.to_string_lossy().to_string(),
                &[FileRef { path: f2.to_string_lossy().to_string() }],
            )
            .unwrap();

        let sessions = core.load_sessions(&root.to_string_lossy().to_string());
        assert_eq!(sessions.len(), 2);
        // 后创建的（更新的）排在前面
        assert!(sessions[0].created_at >= sessions[1].created_at);
        // session 名字也应匹配
        assert_eq!(sessions[0].name, PathBuf::from(&report2.session).file_name().unwrap().to_string_lossy().to_string());
        assert_eq!(sessions[1].name, PathBuf::from(&report1.session).file_name().unwrap().to_string_lossy().to_string());
    }

    // ─── 测试 13: move_with_fallback 跨盘模拟 ─────────────────────────────

    #[test]
    fn test_move_with_fallback_copy_verify() {
        let dir = temp_dir();
        let src = dir.join("src.txt");
        let dest = dir.join("dst.txt");
        let content = "hello fallback";
        fs::write(&src, content).unwrap();
        let expected = content.len() as u64;

        move_with_fallback(&src, &dest, Some(expected)).unwrap();
        assert!(!src.exists());
        assert!(dest.exists());
        assert_eq!(fs::read_to_string(&dest).unwrap(), content);
        assert_eq!(fs::metadata(&dest).unwrap().len(), expected);
    }

    // ─── 测试 14: delete_permanent 不存在的文件 → failure ────────────────

    #[test]
    fn test_delete_permanent_missing_file() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        // 先隔离一个文件以创建合法 session
        let (fpath, _) = touch(&root, "del_me.txt");
        let _report = core
            .quarantine_files(
                &root.to_string_lossy().to_string(),
                &[FileRef { path: fpath.to_string_lossy().to_string() }],
            )
            .unwrap();

        let sessions = core.load_sessions(&root.to_string_lossy().to_string());
        let items = sessions[0].files.clone();
        let stored_path = PathBuf::from(&items[0].stored);

        // 手动删除隔离文件
        fs::remove_file(&stored_path).unwrap();

        // 再次删除（文件已不存在）
        let dr = core
            .delete_permanent(&root.to_string_lossy().to_string(), &sessions[0].path, &items)
            .unwrap();
        assert_eq!(dr.deleted, 0);
        assert_eq!(dr.failures.len(), 1);
        assert!(dr.failures[0].reason.contains("删除失败"));
    }

    // ─── 测试 15: custom_dir 优先 ─────────────────────────────────────────

    #[test]
    fn test_custom_dir_takes_priority() {
        let root = temp_dir();
        let custom = temp_dir();
        let core = QuarantineCore::new(Some(custom.to_string_lossy().to_string()));

        let qroot = core.quarantine_root(&root.to_string_lossy().to_string());
        assert_eq!(qroot, custom.to_string_lossy().to_string());
    }

    // ─── 测试 16: load_sessions 在 qroot 不存在时返回空 ──────────────────

    #[test]
    fn test_load_sessions_missing_root() {
        let root = temp_dir();
        let core = QuarantineCore::new(None);

        // 确保 qroot 不存在
        let qroot = PathBuf::from(core.quarantine_root(&root.to_string_lossy().to_string()));
        let _ = fs::remove_dir_all(&qroot);

        let sessions = core.load_sessions(&root.to_string_lossy().to_string());
        assert!(sessions.is_empty());
    }
}