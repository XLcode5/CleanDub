// CleanDub v1.2.0 — Tauri 2 入口（Phase 1: IPC stub 层）
// 信封格式与 Electron 版完全一致：{ok: true, data: ...}，前端 bridge.ts 拆包逻辑零改动。
// Phase 2 将用 Rust 引擎逐通道替换 stub（见 docs/tauri-port/dsh-task-spec.md）。
pub mod strategies_core;

use serde_json::{json, Value};

fn ok(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

fn default_settings() -> Value {
    json!({
        "defaultPath": "",
        "strategy": "ShortestName",
        "verify": "Full",
        "detectLinks": true,
        "recurse": true,
        "minSize": 1,
        "excludeDirs": ["$RECYCLE.BIN", "System Volume Information", "node_modules", ".git"],
        "quarantineDir": "",
        "confirmBeforeDelete": true
    })
}

// ---------- 读通道 ----------

#[tauri::command]
fn get_app_settings() -> Value { ok(default_settings()) }

#[tauri::command]
fn get_scan_history() -> Value { ok(json!([])) }

#[tauri::command]
fn get_duplicate_groups(session_id: Option<i64>) -> Value {
    let _ = session_id;
    ok(json!({ "sessionId": null, "groups": [] }))
}

#[tauri::command]
fn get_quarantine_items() -> Value { ok(json!([])) }

#[tauri::command]
fn get_operation_logs() -> Value { ok(json!([])) }

#[tauri::command]
fn get_scan_progress() -> Value {
    ok(json!({ "state": "idle", "sessionId": null, "current": 0, "total": 0 }))
}

#[tauri::command]
fn check_updates() -> Value {
    ok(json!({ "currentVersion": "1.2.0", "latestVersion": "1.2.0", "hasUpdate": false, "downloadUrl": null }))
}

// ---------- 写通道（Phase 2 接入真引擎前的安全 stub）----------

#[tauri::command]
fn update_app_settings(request: tauri::ipc::Request) -> Value {
    // v1.0.x 前端传展开的 Partial<AppSettings> 字段（verify/recurse/detectLinks/...），无 { settings } 包裹键
    // Request 整体接收 args（对齐 Electron 宽松合并语义），Phase 3 接 rusqlite 时逐字段落库
    if let tauri::ipc::InvokeBody::Json(v) = request.body() {
        let _ = v;
    }
    ok(json!({ "saved": true })) }

#[tauri::command]
fn choose_directories() -> Value { ok(json!([])) }

#[tauri::command]
fn start_scan(roots: Value, options: Value) -> Value {
    let _ = (&roots, &options);
    // Phase 2: 接入 Rust 扫描引擎（四段流水线 + scan-progress 事件）
    ok(json!({ "sessionId": null, "scannedFileCount": 0, "duplicateGroupCount": 0, "duplicateFileCount": 0 }))
}

#[tauri::command]
fn cancel_scan() -> Value { ok(json!({ "cancelled": true })) }

#[tauri::command]
fn set_retained_file(group_id: i64, file_id: i64) -> Value {
    let _ = (group_id, file_id); ok(json!({ "ok": true })) }

#[tauri::command]
fn apply_retention_strategy(strategy: String, group_ids: Option<Value>) -> Value {
    let _ = (&strategy, &group_ids);
    ok(json!({ "marked": 0 }))
}

#[tauri::command]
fn quarantine_files(file_ids: Value) -> Value {
    let _ = &file_ids;
    // Phase 2: 隔离区 manifest 双向兼容（硬约束，见 dsh-task-spec.md B 节）
    ok(json!({ "moved": 0, "bytes": 0, "failures": [] }))
}

#[tauri::command]
fn restore_quarantined_files(quarantine_ids: Value) -> Value {
    let _ = &quarantine_ids;
    ok(json!({ "restored": 0, "bytes": 0, "failures": [] }))
}

#[tauri::command]
fn permanently_delete_files(file_ids: Option<Value>, quarantine_ids: Option<Value>) -> Value {
    let _ = (&file_ids, &quarantine_ids);
    // Phase 2: 双通道（fileIds 直删 / quarantineIds 删隔离区）+ 保留文件保护
    ok(json!({ "ok": 0, "failed": 0, "skipped": 0 }))
}

#[tauri::command]
fn delete_scan_history(session_ids: Value) -> Value {
    let _ = &session_ids; ok(json!({ "deleted": 0 })) }

#[tauri::command]
fn reset_app_data() -> Value { ok(json!({ "reset": true })) }

#[tauri::command]
fn open_external(url: String) -> Value {
    let _ = &url; ok(json!({ "opened": true })) }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_app_settings,
            get_scan_history,
            get_duplicate_groups,
            get_quarantine_items,
            get_operation_logs,
            get_scan_progress,
            check_updates,
            update_app_settings,
            choose_directories,
            start_scan,
            cancel_scan,
            set_retained_file,
            apply_retention_strategy,
            quarantine_files,
            restore_quarantined_files,
            permanently_delete_files,
            delete_scan_history,
            reset_app_data,
            open_external
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
