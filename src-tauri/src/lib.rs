// CleanDub v1.2.0 — Tauri 2 入口（Phase 2 集成层：19 commands 全实装）
// 数据目录对齐 Electron 版（%APPDATA%/CleanDub）：老用户 cleandub.db / settings.json 直接复用，零迁移。
// 信封 { ok, data } 与 v1.0.x 逐字节兼容；事件名 scan-progress / scan-state 不变。
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

pub mod db;
pub mod quarantine_core;
pub mod scan_core;
pub mod strategies_core;

use tauri::Emitter;

use db::{Db, ScannedFileRow};
use scan_core::{ProgressSink, ScanOptions, VerifyMode};

// ============================================================
// 设置持久化（对齐 settings.js：字段名/校验/原子写全一致）
// ============================================================

fn default_settings() -> Value {
    json!({
        "defaultPath": "", "strategy": "Cleanest", "verify": "Full",
        "detectLinks": true, "recurse": true, "excludeDirs": [],
        "quarantineDir": "", "confirmBeforeDelete": true
    })
}

fn sanitize_settings(raw: &Value) -> Value {
    let mut s = default_settings();
    if let Some(obj) = raw.as_object() {
        if let Some(v) = obj.get("defaultPath").and_then(|x| x.as_str()) {
            s["defaultPath"] = json!(v);
        }
        if let Some(v) = obj.get("strategy").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) {
            s["strategy"] = json!(v);
        }
        if let Some(v) = obj.get("verify").and_then(|x| x.as_str())
        && ["Full", "Head", "Name", "Size"].contains(&v) {
            s["verify"] = json!(v);
        }
        if let Some(v) = obj.get("detectLinks").and_then(|x| x.as_bool()) {
            s["detectLinks"] = json!(v);
        }
        if let Some(v) = obj.get("recurse").and_then(|x| x.as_bool()) {
            s["recurse"] = json!(v);
        }
        if let Some(v) = obj.get("quarantineDir").and_then(|x| x.as_str()) {
            s["quarantineDir"] = json!(v.trim());
        }
        if let Some(v) = obj.get("confirmBeforeDelete").and_then(|x| x.as_bool()) {
            s["confirmBeforeDelete"] = json!(v);
        }
        if let Some(v) = obj.get("excludeDirs").and_then(|x| x.as_array()) {
            let dirs: Vec<String> = v
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .filter(|x| !x.trim().is_empty())
                .collect();
            s["excludeDirs"] = json!(dirs);
        }
    }
    s
}

/// 应用数据目录（对齐 Electron userData：%APPDATA%/CleanDub，老数据零迁移）
pub fn cleandub_data_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(appdata).join("CleanDub")
}

fn settings_path() -> PathBuf {
    cleandub_data_dir().join("settings.json")
}

fn read_settings() -> Value {
    let raw = std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    sanitize_settings(&raw)
}

fn write_settings(s: &Value) -> Result<(), String> {
    let _ = std::fs::create_dir_all(cleandub_data_dir());
    let path = settings_path();
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
// IPC 信封（与 v1.0.x 逐字节兼容）
// ============================================================

fn ok(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

fn err_envelope(message: &str) -> Value {
    json!({ "ok": false, "error": message })
}

// ============================================================
// 应用状态 + 扫描事件桥
// ============================================================

pub struct AppState {
    db: Mutex<Db>,
    /// session_id == 0 表示 idle（同一时刻只允许一个扫描，对齐 JS）
    scan: Mutex<ScanHandle>,
}

struct ScanHandle {
    cancel: Arc<AtomicBool>,
    session_id: i64,
    progress: Arc<Mutex<Value>>,
}

struct EmitSink {
    app: tauri::AppHandle,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<Value>>,
    session_id: i64,
}

impl ProgressSink for EmitSink {
    fn on_progress(&self, phase: &str, message: String, current: u64, total: u64, percent: f64, elapsed_sec: f64) {
        let payload = json!({
            "state": "running", "sessionId": self.session_id, "phase": phase,
            "message": message, "current": current, "total": total,
            "percent": percent, "elapsedSec": elapsed_sec,
        });
        if let Ok(mut p) = self.progress.lock() {
            *p = payload.clone();
        }
        let _ = self.app.emit("scan-progress", payload);
    }
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

fn scan_guard<'a>(state: &'a tauri::State<AppState>) -> MutexGuard<'a, ScanHandle> {
    state.scan.lock().unwrap()
}

fn iso_now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn file_name_of(p: &str) -> String {
    PathBuf::from(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

// ============================================================
// Commands（19 个通道；前端 kebab-case → snake_case 由 bridge 转换）
// ============================================================

#[tauri::command]
fn get_app_settings() -> Value {
    ok(read_settings())
}

#[tauri::command]
fn update_app_settings(request: tauri::ipc::Request) -> Value {
    // v1.0.x 前端传展开的 Partial<AppSettings> 字段（无 { settings } 包裹键）
    let patch = match request.body() {
        tauri::ipc::InvokeBody::Json(v) => v.clone(),
        _ => json!({}),
    };
    let mut merged = read_settings();
    if let (Some(dst), Some(src)) = (merged.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let clean = sanitize_settings(&merged);
    match write_settings(&clean) {
        Ok(()) => ok(json!({ "saved": true })),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn choose_directories() -> Value {
    match rfd::FileDialog::new().pick_folder() {
        Some(p) => ok(json!({ "paths": [p.to_string_lossy()] })),
        None => ok(json!({ "paths": [] })),
    }
}

#[tauri::command]
fn start_scan(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    roots: Value,
    options: Value,
) -> Value {
    // ---- 1) 参数校验（对齐 JS startScan）----
    let root_list: Vec<String> = match roots.as_array() {
        Some(a) => a
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        None => {
            let single = roots.as_str().map(|s| s.trim().to_string()).unwrap_or_default();
            if single.is_empty() { Vec::new() } else { vec![single] }
        }
    };
    if root_list.is_empty() {
        return err_envelope("至少选择一个扫描目录");
    }
    {
        let guard = scan_guard(&state);
        if guard.session_id != 0 {
            return err_envelope("已有扫描任务正在运行");
        }
    }
    let mut norm_roots = Vec::with_capacity(root_list.len());
    for r in &root_list {
        let full = std::fs::canonicalize(r)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if full.is_empty() || !PathBuf::from(&full).is_dir() {
            return err_envelope(&format!("目录不存在或不可访问: {r}"));
        }
        norm_roots.push(full);
    }

    // ---- 2) 选项（对齐 JS：minSize=1 / recurse=true / detectLinks=false / verify=Full）----
    let opts_obj = options.as_object().cloned().unwrap_or_default();
    let settings = read_settings();
    let g = |k: &str| opts_obj.get(k).or_else(|| settings.get(k));
    let min_size = g("minSize").and_then(|v| v.as_f64()).map(|x| x.max(0.0) as u64).unwrap_or(1);
    let recurse = g("recurse").and_then(|v| v.as_bool()).unwrap_or(true);
    let detect_links = g("detectLinks").and_then(|v| v.as_bool()).unwrap_or(false);
    let verify = match g("verify").and_then(|v| v.as_str()) {
        Some("Head") | Some("Name") | Some("Size") => VerifyMode::Head,
        _ => VerifyMode::Full,
    };
    let mut exclude_dirs: Vec<String> = g("excludeDirs")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    for d in scan_core::DEFAULT_EXCLUDE_DIRS {
        exclude_dirs.push(d.to_string());
    }
    let scan_opts = ScanOptions { min_size, exclude_dirs, verify, recurse, detect_links };

    // ---- 3) 会话落库 + 运行状态 ----
    let started_at = iso_now();
    let session_id = match state.db.lock().unwrap().insert_scan_session(&started_at, "running") {
        Ok(id) => id,
        Err(e) => return err_envelope(&e),
    };
    if let Err(e) = state.db.lock().unwrap().insert_scan_roots(session_id, &norm_roots) {
        return err_envelope(&e);
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(json!({
        "state": "running", "sessionId": session_id, "phase": "enumerate",
        "message": "正在枚举文件…", "current": 0, "total": 0, "percent": 0, "elapsedSec": 0
    })));
    {
        let mut guard = state.scan.lock().unwrap();
        guard.cancel = Arc::clone(&cancel);
        guard.session_id = session_id;
        guard.progress = Arc::clone(&progress);
    }
    let _ = app.emit("scan-state", json!({ "state": "running", "sessionId": session_id }));

    // ---- 4) 引擎跑（同步 command 在 Tauri 专用线程，不阻塞 UI；对齐 JS await 语义）----
    let t0 = std::time::Instant::now();
    let sink = EmitSink { app: app.clone(), cancel, progress: Arc::clone(&progress), session_id };
    let result = scan_core::scan(&norm_roots, &scan_opts, &sink, 0.0);

    // ---- 5) 结果落库 + 事件 + 返回（形状对齐 JS done/end）----
    {
        let mut guard = state.scan.lock().unwrap();
        guard.session_id = 0;
        guard.progress = Arc::new(Mutex::new(json!({ "state": "idle" })));
    }
    let duration_ms = t0.elapsed().as_millis() as i64;
    match result {
        Ok(r) => {
            let mut groups_out = Vec::with_capacity(r.groups.len());
            let mut dup_file_count = 0i64;
            let mut reclaimable = 0i64;
            for grp in &r.groups {
                let gid = state
                    .db
                    .lock()
                    .unwrap()
                    .insert_duplicate_group(session_id, &grp.sha256, grp.file_size as i64)
                    .unwrap_or(-1);
                let rows: Vec<ScannedFileRow> = grp
                    .files
                    .iter()
                    .map(|f| ScannedFileRow {
                        canonical_path: f.path.clone(),
                        file_name: f.name.clone(),
                        extension: PathBuf::from(&f.name)
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(|e| format!(".{}", e.to_lowercase())),
                        file_size: f.size as i64,
                        modified_at: Some(iso_now()),
                        sha256: Some(grp.sha256.clone()),
                        duplicate_group_id: Some(gid),
                        scan_status: "ok".into(),
                        error_message: None,
                    })
                    .collect();
                let ids = state.db.lock().unwrap().insert_scanned_files(session_id, &rows).unwrap_or_default();
                let files_json: Vec<Value> = grp
                    .files
                    .iter()
                    .enumerate()
                    .map(|(i, f)| {
                        json!({
                            "id": ids.get(i).copied().unwrap_or(-1),
                            "path": f.path, "name": f.name, "size": f.size, "modifiedAt": f.mtime
                        })
                    })
                    .collect();
                dup_file_count += grp.files.len() as i64;
                reclaimable += grp.file_size as i64 * (grp.files.len() as i64 - 1);
                groups_out.push(json!({
                    "id": gid, "sha256": grp.sha256, "fileSize": grp.file_size, "files": files_json,
                }));
            }
            let err_summary = if r.error_count > 0 {
                Some(format!("{} 个文件无法读取，已跳过", r.error_count))
            } else {
                None
            };
            let _ = state.db.lock().unwrap().complete_scan_session(
                session_id, "completed", r.scanned_file_count as i64, groups_out.len() as i64,
                dup_file_count, reclaimable, duration_ms, err_summary.as_deref(), &iso_now(),
            );
            let done = json!({
                "state": "completed", "sessionId": session_id,
                "scannedFileCount": r.scanned_file_count, "duplicateGroupCount": groups_out.len(),
                "duplicateFileCount": dup_file_count, "reclaimableBytes": reclaimable,
                "errorCount": r.error_count, "durationMs": duration_ms, "groups": groups_out,
            });
            let _ = app.emit("scan-state", &done);
            ok(done)
        }
        Err(e) => {
            let (status, message) = match &e {
                scan_core::CleanError::Cancelled => ("cancelled", "用户取消".to_string()),
                other => ("failed", other.to_string()),
            };
            let _ = state.db.lock().unwrap().complete_scan_session(
                session_id, status, 0, 0, 0, 0, duration_ms, Some(&message), &iso_now(),
            );
            let end = json!({ "state": status, "sessionId": session_id, "error": message });
            let _ = app.emit("scan-state", &end);
            if status == "cancelled" {
                ok(end) // JS 语义：取消不 throw，正常返回 end
            } else {
                err_envelope(end["error"].as_str().unwrap_or("扫描失败"))
            }
        }
    }
}

#[tauri::command]
fn cancel_scan(state: tauri::State<AppState>) -> Value {
    let guard = scan_guard(&state);
    if guard.session_id == 0 {
        return err_envelope("没有正在运行的扫描");
    }
    guard.cancel.store(true, Ordering::SeqCst);
    ok(json!({ "cancelled": true }))
}

#[tauri::command]
fn get_scan_progress(state: tauri::State<AppState>) -> Value {
    let guard = scan_guard(&state);
    if guard.session_id == 0 {
        return ok(json!({ "state": "idle" }));
    }
    let p = guard.progress.lock().unwrap().clone();
    ok(p)
}

#[tauri::command]
fn get_scan_history(state: tauri::State<AppState>) -> Value {
    match state.db.lock().unwrap().get_scan_history() {
        Ok(v) => ok(v),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn get_duplicate_groups(state: tauri::State<AppState>, session_id: Option<i64>) -> Value {
    match state.db.lock().unwrap().get_duplicate_groups(session_id) {
        Ok(v) => ok(v),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn get_operation_logs(state: tauri::State<AppState>, limit: Option<i64>) -> Value {
    match state.db.lock().unwrap().get_operation_logs(limit.unwrap_or(200)) {
        Ok(v) => ok(v),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn get_quarantine_items(state: tauri::State<AppState>, payload: Option<Value>) -> Value {
    // 兼容 { scanRoot } → 磁盘 manifest 会话列表；{ status } / 空 → SQLite 列表（对齐 JS 双路径）
    if let Some(p) = &payload
    && let Some(root) = p.get("scanRoot").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        let core = quarantine_core::QuarantineCore::new(None);
        return ok(json!(core.load_sessions(root)));
    }
    let status = payload.as_ref().and_then(|p| p.get("status")).and_then(|v| v.as_str());
    match state.db.lock().unwrap().get_quarantine_items(status) {
        Ok(v) => ok(v),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn set_retained_file(state: tauri::State<AppState>, group_id: i64, file_id: i64) -> Value {
    match state.db.lock().unwrap().set_retained_file(group_id, file_id) {
        Ok(()) => ok(json!({ "ok": true })),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn apply_retention_strategy(
    state: tauri::State<AppState>,
    strategy: String,
    payload: Option<Value>,
) -> Value {
    let group_ids: Option<Vec<i64>> = payload
        .as_ref()
        .and_then(|p| p.get("groupIds"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect());
    let skip_marked = payload
        .as_ref()
        .and_then(|p| p.get("skipMarked"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let sid = payload.as_ref().and_then(|p| p.get("sessionId")).and_then(|v| v.as_i64());
    match state.db.lock().unwrap().apply_retention_strategy(sid, &strategy, group_ids, skip_marked) {
        Ok(v) => ok(v),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn quarantine_files(state: tauri::State<AppState>, file_ids: Vec<i64>) -> Value {
    if file_ids.is_empty() {
        return err_envelope("没有需要隔离的文件");
    }
    let files = match state.db.lock().unwrap().get_files_by_ids(&file_ids) {
        Ok(f) => f,
        Err(e) => return err_envelope(&e),
    };
    if files.is_empty() {
        return err_envelope("文件不存在或已被处理");
    }
    let settings = read_settings();
    let custom = settings["quarantineDir"].as_str().filter(|s| !s.is_empty()).map(String::from);
    // 按扫描根分组执行（跨根安全，对齐 JS byRoot）
    let mut by_root: std::collections::BTreeMap<String, Vec<(i64, String)>> = Default::default();
    for (id, path, _name, _size) in &files {
        let root = state.db.lock().unwrap().scan_root_of_file(*id).unwrap_or_default();
        if root.is_empty() {
            return err_envelope("无法确定扫描根目录（扫描历史可能已清空）");
        }
        by_root.entry(root).or_default().push((*id, path.clone()));
    }
    let mut moved = 0i64;
    let mut bytes = 0i64;
    let mut failures: Vec<Value> = Vec::new();
    for (root, list) in &by_root {
        let core = quarantine_core::QuarantineCore::new(custom.clone());
        let refs: Vec<quarantine_core::FileRef> =
            list.iter().map(|(_, p)| quarantine_core::FileRef { path: p.clone() }).collect();
        match core.quarantine_files(root, &refs) {
            Ok(rep) => {
                moved += rep.moved as i64;
                bytes += rep.bytes as i64;
                for f in &rep.failures {
                    failures.push(json!({ "path": f.path, "reason": f.reason }));
                }
                // SQLite 落库：manifest 由 core 写盘（权威），明细回读最新 session
                let sessions = core.load_sessions(root);
                if let Some(sess) = sessions.iter().find(|s| s.path == rep.session) {
                    let items: Vec<(String, String, String, String, String, i64)> = sess
                        .files
                        .iter()
                        .map(|e| {
                            (
                                e.original.clone(),
                                e.stored.clone(),
                                sess.path.clone(),
                                root.clone(),
                                file_name_of(&e.original),
                                e.size as i64,
                            )
                        })
                        .collect();
                    if !items.is_empty()
                    && let Err(e) = state.db.lock().unwrap().insert_quarantine_items(&items) {
                        failures.push(json!({ "path": root, "reason": format!("SQLite 记录失败: {e}") }));
                    }
                }
            }
            Err(e) => {
                for (_, p) in list {
                    failures.push(json!({ "path": p, "reason": e.to_string() }));
                }
            }
        }
    }
    let fail_json = serde_json::to_string(&failures).unwrap_or_default();
    let _ = state.db.lock().unwrap().insert_operation_log(
        "quarantine", None,
        if failures.is_empty() { "ok" } else { "partial" },
        if failures.is_empty() { None } else { Some(&fail_json) },
    );
    ok(json!({ "moved": moved, "bytes": bytes, "failures": failures }))
}

#[tauri::command]
fn restore_quarantined_files(state: tauri::State<AppState>, quarantine_ids: Vec<i64>) -> Value {
    if quarantine_ids.is_empty() {
        return err_envelope("没有需要还原的文件");
    }
    let items = match state.db.lock().unwrap().get_quarantine_items_by_ids(&quarantine_ids) {
        Ok(v) => v,
        Err(e) => return err_envelope(&e),
    };
    if items.is_empty() {
        return err_envelope("隔离记录不存在");
    }
    let mut restored = 0i64;
    let mut bytes = 0i64;
    let mut failures: Vec<Value> = Vec::new();
    let mut succeeded_ids: Vec<i64> = Vec::new();
    let mut by_session: std::collections::BTreeMap<String, Vec<Value>> = Default::default();
    for it in items {
        if it["status"] == "restored" || it["status"] == "deleted" {
            failures.push(json!({ "path": it["original_path"], "reason": "记录状态不允许还原" }));
            continue;
        }
        by_session
            .entry(it["session_dir"].as_str().unwrap_or_default().to_string())
            .or_default()
            .push(it);
    }
    let core = quarantine_core::QuarantineCore::new(None);
    for (sess, list) in &by_session {
        let scan_root = list[0]["scan_root"].as_str().unwrap_or_default().to_string();
        let entries: Vec<quarantine_core::QuarantineItem> = list
            .iter()
            .map(|it| quarantine_core::QuarantineItem {
                original: it["original_path"].as_str().unwrap_or_default().to_string(),
                stored: it["quarantine_path"].as_str().unwrap_or_default().to_string(),
                size: it["file_size"].as_i64().unwrap_or(0) as u64,
                moved_at: it["quarantined_at"].as_str().unwrap_or_default().to_string(),
            })
            .collect();
        match core.restore(&scan_root, sess, &entries) {
            Ok(rep) => {
                restored += rep.restored as i64;
                bytes += rep.bytes as i64;
                for f in &rep.failures {
                    failures.push(json!({ "path": f.path, "reason": f.reason }));
                }
                for it in list {
                    let sp = it["quarantine_path"].as_str().unwrap_or_default().to_string();
                    if rep.succeeded_stored.iter().any(|s| s.eq_ignore_ascii_case(&sp))
                    && let Some(id) = it["id"].as_i64() {
                        succeeded_ids.push(id);
                    }
                }
            }
            Err(e) => {
                for it in list {
                    failures.push(json!({ "path": it["original_path"], "reason": e.to_string() }));
                }
            }
        }
    }
    if !succeeded_ids.is_empty() {
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        let _ = state.db.lock().unwrap().mark_quarantine_items(&succeeded_ids, "restored", Some(&now));
    }
    let fail_json = serde_json::to_string(&failures).unwrap_or_default();
    let _ = state.db.lock().unwrap().insert_operation_log(
        "restore", None,
        if failures.is_empty() { "ok" } else { "partial" },
        if failures.is_empty() { None } else { Some(&fail_json) },
    );
    ok(json!({ "restored": restored, "bytes": bytes, "failures": failures }))
}

#[tauri::command]
fn permanently_delete_files(
    state: tauri::State<AppState>,
    file_ids: Option<Vec<i64>>,
    quarantine_ids: Option<Vec<i64>>,
) -> Value {
    // ---- 通道 1：fileIds → 直删磁盘文件（清理页，v1.0.2 语义）----
    if let Some(fids) = file_ids {
        if fids.is_empty() {
            return err_envelope("没有需要删除的文件");
        }
        let files = match state.db.lock().unwrap().get_files_by_ids(&fids) {
            Ok(f) => f,
            Err(e) => return err_envelope(&e),
        };
        if files.is_empty() {
            return err_envelope("文件不存在或已被处理（可能已被隔离/删除）");
        }
        let protected = state.db.lock().unwrap().get_protected_file_ids(&fids);
        let deletable: Vec<(i64, String)> = files
            .into_iter()
            .filter(|(id, _, _, _)| !protected.contains(id))
            .map(|(id, path, _, _)| (id, path))
            .collect();
        if deletable.is_empty() {
            return err_envelope("所选文件均为保留文件，已拒绝删除");
        }
        let mut by_root: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for (id, path) in &deletable {
            let root = state.db.lock().unwrap().scan_root_of_file(*id).unwrap_or_default();
            if root.is_empty() {
                return err_envelope("无法确定扫描根目录（扫描历史可能已清空）");
            }
            by_root.entry(root).or_default().push(path.clone());
        }
        let mut deleted = 0i64;
        let mut failed = 0i64;
        let core = quarantine_core::QuarantineCore::new(None);
        for (root, paths) in &by_root {
            match core.delete_scan_files(root, paths) {
                Ok(rep) => {
                    deleted += rep.deleted as i64;
                    failed += rep.failures.len() as i64;
                }
                Err(_) => failed += paths.len() as i64,
            }
        }
        let _ = state.db.lock().unwrap().insert_operation_log("delete", None, if failed == 0 { "ok" } else { "partial" }, None);
        return ok(json!({ "ok": deleted, "failed": failed, "skipped": protected.len() }));
    }
    // ---- 通道 2：quarantineIds → 删隔离区文件（个人中心批量删除）----
    if let Some(qids) = quarantine_ids {
        if qids.is_empty() {
            return err_envelope("没有需要删除的文件");
        }
        let items = match state.db.lock().unwrap().get_quarantine_items_by_ids(&qids) {
            Ok(v) => v,
            Err(e) => return err_envelope(&e),
        };
        if items.is_empty() {
            return err_envelope("隔离记录不存在");
        }
        let mut deleted = 0i64;
        let mut bytes = 0i64;
        let mut failures: Vec<Value> = Vec::new();
        let mut succeeded_ids: Vec<i64> = Vec::new();
        let mut by_session: std::collections::BTreeMap<String, Vec<Value>> = Default::default();
        for it in items {
            if it["status"] == "deleted" {
                continue;
            }
            by_session
                .entry(it["session_dir"].as_str().unwrap_or_default().to_string())
                .or_default()
                .push(it);
        }
        let core = quarantine_core::QuarantineCore::new(None);
        for (sess, list) in &by_session {
            let scan_root = list[0]["scan_root"].as_str().unwrap_or_default().to_string();
            let entries: Vec<quarantine_core::QuarantineItem> = list
                .iter()
                .map(|it| quarantine_core::QuarantineItem {
                    original: it["original_path"].as_str().unwrap_or_default().to_string(),
                    stored: it["quarantine_path"].as_str().unwrap_or_default().to_string(),
                    size: it["file_size"].as_i64().unwrap_or(0) as u64,
                    moved_at: String::new(),
                })
                .collect();
            match core.delete_permanent(&scan_root, sess, &entries) {
                Ok(rep) => {
                    deleted += rep.deleted as i64;
                    bytes += rep.bytes as i64;
                    for f in &rep.failures {
                        failures.push(json!({ "path": f.path, "reason": f.reason }));
                    }
                    for it in list {
                        let sp = it["quarantine_path"].as_str().unwrap_or_default().to_string();
                        if rep.succeeded_stored.iter().any(|s| s.eq_ignore_ascii_case(&sp))
                        && let Some(id) = it["id"].as_i64() {
                            succeeded_ids.push(id);
                        }
                    }
                }
                Err(e) => {
                    for it in list {
                        failures.push(json!({ "path": it["quarantine_path"], "reason": e.to_string() }));
                    }
                }
            }
        }
        if !succeeded_ids.is_empty() {
            let _ = state.db.lock().unwrap().mark_quarantine_items(&succeeded_ids, "deleted", None);
        }
        let fail_json = serde_json::to_string(&failures).unwrap_or_default();
        let _ = state.db.lock().unwrap().insert_operation_log(
            "delete", None,
            if failures.is_empty() { "ok" } else { "partial" },
            if failures.is_empty() { None } else { Some(&fail_json) },
        );
        return ok(json!({ "ok": deleted, "failed": failures.len(), "bytes": bytes, "failures": failures }));
    }
    err_envelope("参数无效：需要 fileIds 或 quarantineIds")
}

#[tauri::command]
fn delete_scan_history(state: tauri::State<AppState>, session_ids: Vec<i64>) -> Value {
    let mut deleted = 0i64;
    for sid in session_ids {
        if state.db.lock().unwrap().delete_scan_history(sid).is_ok() {
            deleted += 1;
        }
    }
    ok(json!({ "deleted": deleted }))
}

#[tauri::command]
fn reset_app_data(state: tauri::State<AppState>, payload: Option<Value>) -> Value {
    let scope = payload
        .as_ref()
        .and_then(|p| p.get("scope"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match state.db.lock().unwrap().reset_app_data(scope) {
        Ok(v) => ok(v),
        Err(e) => err_envelope(&e),
    }
}

#[tauri::command]
fn open_external(url: String) -> Value {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .creation_flags(0x08000000)
        .spawn();
    ok(json!({ "opened": true }))
}

#[tauri::command]
fn check_updates() -> Value {
    // 对齐 JS Check-UpdateAsync：GitHub latest release 比对本地版本
    let local = env!("CARGO_PKG_VERSION");
    let fetch = ureq::get("https://api.github.com/repos/XLcode5/CleanDub/releases/latest")
        .set("User-Agent", "CleanDub-Updater")
        .timeout(std::time::Duration::from_secs(10))
        .call();
    match fetch {
        Ok(resp) => {
            let body: Value = match resp.into_json() {
                Ok(v) => v,
                Err(e) => return err_envelope(&format!("解析更新信息失败: {e}")),
            };
            let latest = body["tag_name"]
                .as_str()
                .unwrap_or("")
                .trim_start_matches('v')
                .to_string();
            let has_update = version_gt(&latest, local);
            ok(json!({
                "currentVersion": local,
                "latestVersion": latest,
                "hasUpdate": has_update,
                "downloadUrl": body["assets"][0]["browser_download_url"],
                "checkedAt": iso_now(),
            }))
        }
        Err(e) => err_envelope(&format!("检查更新失败: {e}")),
    }
}

fn version_gt(a: &str, b: &str) -> bool {
    let pa: Vec<u64> = a.split('.').filter_map(|x| x.parse().ok()).collect();
    let pb: Vec<u64> = b.split('.').filter_map(|x| x.parse().ok()).collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x > y {
            return true;
        }
        if x < y {
            return false;
        }
    }
    false
}

// ============================================================
// 入口
// ============================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = cleandub_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    let db = Db::open(data_dir.join("cleandub.db")).expect("数据库打开失败");
    let app_state = AppState {
        db: Mutex::new(db),
        scan: Mutex::new(ScanHandle {
            cancel: Arc::new(AtomicBool::new(false)),
            session_id: 0,
            progress: Arc::new(Mutex::new(json!({ "state": "idle" }))),
        }),
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_app_settings,
            update_app_settings,
            choose_directories,
            start_scan,
            cancel_scan,
            get_scan_progress,
            get_scan_history,
            get_duplicate_groups,
            get_operation_logs,
            get_quarantine_items,
            set_retained_file,
            apply_retention_strategy,
            quarantine_files,
            restore_quarantined_files,
            permanently_delete_files,
            delete_scan_history,
            reset_app_data,
            open_external,
            check_updates
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
