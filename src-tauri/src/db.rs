// CleanDub v1.2.0 — SQLite 持久层（rusqlite bundled）
// schema 与 v1.0.x（electron/db.js）逐字节兼容：老用户 cleandub.db 直接可用。
// 所有返回走 serde_json::Value（调用方即 IPC 层，直接组 {ok,data} 信封）。
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

use crate::strategies_core::{pick_keeper, KeeperCandidate, RetainStrategy};

pub const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scan_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','cancelled','failed')),
  scanned_file_count INTEGER NOT NULL DEFAULT 0,
  duplicate_group_count INTEGER NOT NULL DEFAULT 0,
  duplicate_file_count INTEGER NOT NULL DEFAULT 0,
  reclaimable_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS scan_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_session_id INTEGER NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  directory_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scanned_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_session_id INTEGER NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  duplicate_group_id INTEGER REFERENCES duplicate_groups(id) ON DELETE SET NULL,
  canonical_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT,
  file_size INTEGER NOT NULL CHECK(file_size >= 0),
  modified_at TEXT,
  sha256 TEXT,
  scan_status TEXT NOT NULL DEFAULT 'ok' CHECK(scan_status IN ('ok','error','skipped')),
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_scanned_files_session ON scanned_files(scan_session_id);
CREATE INDEX IF NOT EXISTS idx_scanned_files_group ON scanned_files(duplicate_group_id);
CREATE INDEX IF NOT EXISTS idx_scanned_files_sha ON scanned_files(sha256);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_session_id INTEGER NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size >= 0),
  retained_file_id INTEGER REFERENCES scanned_files(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_dup_groups_session ON duplicate_groups(scan_session_id);

CREATE TABLE IF NOT EXISTS quarantine_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_path TEXT NOT NULL,
  quarantine_path TEXT NOT NULL,
  session_dir TEXT NOT NULL,
  scan_root TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  quarantined_at TEXT NOT NULL,
  restored_at TEXT,
  status TEXT NOT NULL DEFAULT 'quarantined' CHECK(status IN ('quarantined','restored','deleted')),
  operation_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine_items(status);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_type TEXT NOT NULL,
  target_path TEXT,
  operation_status TEXT NOT NULL DEFAULT 'ok' CHECK(operation_status IN ('ok','failed','partial')),
  created_at TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_op_logs_created ON operation_logs(created_at);
"#;

pub struct Db {
    pub conn: Connection,
}

#[derive(Debug, Clone)]
pub struct ScannedFileRow {
    pub canonical_path: String,
    pub file_name: String,
    pub extension: Option<String>,
    pub file_size: i64,
    pub modified_at: Option<String>,
    pub sha256: Option<String>,
    pub duplicate_group_id: Option<i64>,
    pub scan_status: String,
    pub error_message: Option<String>,
}

impl Db {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let p = path.as_ref();
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(p).map_err(|e| format!("打开数据库失败: {e}"))?;
        conn.execute_batch(SCHEMA).map_err(|e| format!("初始化 schema 失败: {e}"))?;
        Ok(Db { conn })
    }

    // ---------- scan_sessions ----------
    pub fn insert_scan_session(&self, started_at: &str, status: &str) -> Result<i64, String> {
        self.conn
            .prepare("INSERT INTO scan_sessions (started_at, status) VALUES (?, ?)")
            .and_then(|mut s| s.insert(params![started_at, status]))
            .map_err(|e| format!("insert_scan_session: {e}"))
    }

    pub fn insert_scan_roots(&self, sid: i64, roots: &[String]) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare("INSERT INTO scan_roots (scan_session_id, directory_path) VALUES (?, ?)")
                .map_err(|e| e.to_string())?;
            for r in roots {
                stmt.execute(params![sid, r]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn insert_scanned_files(&self, sid: i64, rows: &[ScannedFileRow]) -> Result<Vec<i64>, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut ids = Vec::with_capacity(rows.len());
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO scanned_files (scan_session_id, duplicate_group_id, canonical_path, file_name, extension, file_size, modified_at, sha256, scan_status, error_message)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .map_err(|e| e.to_string())?;
            for r in rows {
                let id = stmt
                    .insert(params![
                        sid, r.duplicate_group_id, r.canonical_path, r.file_name,
                        r.extension, r.file_size, r.modified_at, r.sha256,
                        r.scan_status, r.error_message
                    ])
                    .map_err(|e| e.to_string())?;
                ids.push(id);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(ids)
    }

    pub fn insert_duplicate_group(&self, sid: i64, sha256: &str, file_size: i64) -> Result<i64, String> {
        self.conn
            .prepare("INSERT INTO duplicate_groups (scan_session_id, sha256, file_size) VALUES (?, ?, ?)")
            .and_then(|mut s| s.insert(params![sid, sha256, file_size]))
            .map_err(|e| format!("insert_duplicate_group: {e}"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_scan_session(
        &self, sid: i64, status: &str, scanned: i64, groups: i64, dup_files: i64,
        reclaimable: i64, duration_ms: i64, error_summary: Option<&str>, completed_at: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE scan_sessions SET completed_at = ?, status = ?, scanned_file_count = ?, duplicate_group_count = ?, duplicate_file_count = ?, reclaimable_bytes = ?, duration_ms = ?, error_summary = ? WHERE id = ?",
                params![completed_at, status, scanned, groups, dup_files, reclaimable, duration_ms, error_summary, sid],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn latest_finished_session(&self) -> Option<i64> {
        self.conn
            .query_row(
                "SELECT id FROM scan_sessions WHERE status IN ('completed','cancelled') ORDER BY id DESC LIMIT 1",
                [], |r| r.get(0),
            )
            .ok()
    }

    pub fn get_scan_history(&self) -> Result<Value, String> {
        let mut stmt = self.conn
            .prepare("SELECT id, started_at, completed_at, status, scanned_file_count, duplicate_group_count, duplicate_file_count, reclaimable_bytes, duration_ms, error_summary FROM scan_sessions ORDER BY id DESC")
            .map_err(|e| e.to_string())?;
        let sessions = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "started_at": r.get::<_, String>(1)?,
                    "completed_at": r.get::<_, Option<String>>(2)?, "status": r.get::<_, String>(3)?,
                    "scanned_file_count": r.get::<_, i64>(4)?, "duplicate_group_count": r.get::<_, i64>(5)?,
                    "duplicate_file_count": r.get::<_, i64>(6)?, "reclaimable_bytes": r.get::<_, i64>(7)?,
                    "duration_ms": r.get::<_, i64>(8)?, "error_summary": r.get::<_, Option<String>>(9)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(sessions.len());
        for s in sessions {
            let sid = s["id"].as_i64().unwrap();
            let mut roots = Vec::new();
            let mut stmt = self.conn
                .prepare("SELECT directory_path FROM scan_roots WHERE scan_session_id = ?")
                .map_err(|e| e.to_string())?;
            let it = stmt
                .query_map([sid], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for p in it {
                roots.push(p.map_err(|e| e.to_string())?);
            }
            let mut obj = s;
            obj["roots"] = json!(roots);
            out.push(obj);
        }
        Ok(json!(out))
    }

    pub fn get_duplicate_groups(&self, session_id: Option<i64>) -> Result<Value, String> {
        let sid = match session_id.or_else(|| self.latest_finished_session()) {
            Some(s) => s,
            None => return Ok(json!({ "sessionId": null, "groups": [] })),
        };
        let mut stmt = self.conn
            .prepare("SELECT id, sha256, file_size, retained_file_id FROM duplicate_groups WHERE scan_session_id = ? ORDER BY file_size DESC")
            .map_err(|e| e.to_string())?;
        let gids: Vec<(i64, String, i64, Option<i64>)> = stmt
            .query_map([sid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let mut groups = Vec::with_capacity(gids.len());
        for (id, sha256, size, retained) in gids {
            let mut files = Vec::new();
            let mut fstmt = self.conn
                .prepare("SELECT id, canonical_path, file_name, file_size, modified_at, sha256 FROM scanned_files WHERE duplicate_group_id = ? ORDER BY canonical_path")
                .map_err(|e| e.to_string())?;
            let it = fstmt
                .query_map([id], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?, "canonical_path": r.get::<_, String>(1)?,
                        "file_name": r.get::<_, String>(2)?, "file_size": r.get::<_, i64>(3)?,
                        "modified_at": r.get::<_, Option<String>>(4)?, "sha256": r.get::<_, Option<String>>(5)?,
                    }))
                })
                .map_err(|e| e.to_string())?;
            for f in it {
                files.push(f.map_err(|e| e.to_string())?);
            }
            groups.push(json!({
                "id": id, "sha256": sha256, "file_size": size,
                "retained_file_id": retained, "files": files,
            }));
        }
        Ok(json!({ "sessionId": sid, "groups": groups }))
    }

    pub fn set_retained_file(&self, group_id: i64, file_id: i64) -> Result<(), String> {
        let count: i64 = self.conn
            .query_row(
                "SELECT COUNT(*) FROM scanned_files WHERE id = ? AND duplicate_group_id = ?",
                params![file_id, group_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("文件不属于该重复组".into());
        }
        self.conn
            .execute("UPDATE duplicate_groups SET retained_file_id = ? WHERE id = ?", params![file_id, group_id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// 批量保留策略（对齐 db.js applyRetentionStrategy：skipMarked 默认 true）
    pub fn apply_retention_strategy(
        &self, session_id: Option<i64>, strategy: &str, group_ids: Option<Vec<i64>>, skip_marked: bool,
    ) -> Result<Value, String> {
        let sid = match session_id.or_else(|| self.latest_finished_session()) {
            Some(s) => s,
            None => return Err("没有可用的扫描会话".into()),
        };
        let strat = RetainStrategy::parse(strategy);
        let groups: Vec<(i64, Option<i64>)> = match &group_ids {
            Some(ids) if ids.is_empty() => {
                return Ok(json!({ "sessionId": sid, "strategy": strategy, "groupsUpdated": 0, "skipped": 0 }));
            }
            Some(ids) => {
                let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!(
                    "SELECT id, retained_file_id FROM duplicate_groups WHERE scan_session_id = ? AND id IN ({placeholders})"
                );
                let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(sid)];
                for i in ids {
                    params_vec.push(Box::new(*i));
                }
                let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
                let refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
                let it = stmt
                    .query_map(refs.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(|e| e.to_string())?;
                it.collect::<Result<_, _>>().map_err(|e| e.to_string())?
            }
            None => {
                let mut stmt = self.conn
                    .prepare("SELECT id, retained_file_id FROM duplicate_groups WHERE scan_session_id = ?")
                    .map_err(|e| e.to_string())?;
                let it = stmt
                    .query_map([sid], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(|e| e.to_string())?;
                it.collect::<Result<_, _>>().map_err(|e| e.to_string())?
            }
        };
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut updated = 0i64;
        let mut skipped = 0i64;
        {
            let mut files_stmt = tx
                .prepare("SELECT id, canonical_path, file_name, modified_at FROM scanned_files WHERE duplicate_group_id = ?")
                .map_err(|e| e.to_string())?;
            let mut upd_stmt = tx
                .prepare("UPDATE duplicate_groups SET retained_file_id = ? WHERE id = ?")
                .map_err(|e| e.to_string())?;
            for (gid, retained) in groups {
                if skip_marked && retained.is_some() {
                    skipped += 1;
                    continue;
                }
                let cands: Vec<KeeperCandidate> = files_stmt
                    .query_map([gid], |r| {
                        Ok(KeeperCandidate {
                            id: r.get(0)?, canonical_path: r.get(1)?,
                            file_name: r.get(2)?, modified_at: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        })
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                if cands.is_empty() {
                    continue;
                }
                if let Some(k) = pick_keeper(&cands, strat) {
                    upd_stmt.execute(params![k.id, gid]).map_err(|e| e.to_string())?;
                    updated += 1;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(json!({ "sessionId": sid, "strategy": strategy, "groupsUpdated": updated, "skipped": skipped }))
    }

    pub fn delete_scan_history(&self, sid: i64) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for sql in [
            "DELETE FROM scanned_files WHERE scan_session_id = ?1",
            "DELETE FROM duplicate_groups WHERE scan_session_id = ?1",
            "DELETE FROM scan_roots WHERE scan_session_id = ?1",
            "DELETE FROM scan_sessions WHERE id = ?1",
        ] {
            tx.execute(sql, params![sid]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    // ---------- 文件查询 ----------
    pub fn get_files_by_ids(&self, ids: &[i64]) -> Result<Vec<(i64, String, String, i64)>, String> {
        let mut out = Vec::new();
        let mut stmt = self.conn
            .prepare("SELECT id, canonical_path, file_name, file_size FROM scanned_files WHERE id = ?")
            .map_err(|e| e.to_string())?;
        for id in ids {
            if let Ok(row) = stmt.query_row([id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            }) {
                out.push(row);
            }
        }
        Ok(out)
    }

    pub fn scan_root_of_file(&self, file_id: i64) -> Option<String> {
        self.conn
            .query_row(
                "SELECT r.directory_path FROM scanned_files f JOIN scan_roots r ON r.scan_session_id = f.scan_session_id WHERE f.id = ? LIMIT 1",
                [file_id], |r| r.get(0),
            )
            .ok()
    }

    pub fn get_protected_file_ids(&self, file_ids: &[i64]) -> HashSet<i64> {
        let mut set = HashSet::new();
        let mut stmt = match self.conn.prepare(
            "SELECT g.retained_file_id FROM scanned_files f JOIN duplicate_groups g ON g.id = f.duplicate_group_id WHERE f.id = ? AND g.retained_file_id IS NOT NULL",
        ) {
            Ok(s) => s,
            Err(_) => return set,
        };
        for id in file_ids {
            if let Ok(rid) = stmt.query_row([id], |r| r.get::<_, i64>(0)) {
                set.insert(rid);
            }
        }
        set
    }

    // ---------- quarantine_items ----------
    pub fn insert_quarantine_items(
        &self, items: &[(String, String, String, String, String, i64)],
    ) -> Result<(), String> {
        // (original, stored, session_dir, scan_root, file_name, size)
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO quarantine_items (original_path, quarantine_path, session_dir, scan_root, file_name, file_size, quarantined_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'quarantined')",
                )
                .map_err(|e| e.to_string())?;
            for (orig, stored, sess, root, name, size) in items {
                let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                stmt.execute(params![orig, stored, sess, root, name, size, now])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn get_quarantine_items(&self, status: Option<&str>) -> Result<Value, String> {
        let (sql, bind): (String, Option<String>) = match status {
            Some(s) if !s.is_empty() => (
                "SELECT * FROM quarantine_items WHERE status = ? ORDER BY id DESC".into(),
                Some(s.to_string()),
            ),
            _ => ("SELECT * FROM quarantine_items ORDER BY id DESC".into(), None),
        };
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let map_row = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "original_path": r.get::<_, String>(1)?,
                "quarantine_path": r.get::<_, String>(2)?,
                "session_dir": r.get::<_, String>(3)?,
                "scan_root": r.get::<_, String>(4)?,
                "file_name": r.get::<_, String>(5)?,
                "file_size": r.get::<_, i64>(6)?,
                "sha256": r.get::<_, Option<String>>(7)?,
                "quarantined_at": r.get::<_, String>(8)?,
                "restored_at": r.get::<_, Option<String>>(9)?,
                "status": r.get::<_, String>(10)?,
                "operation_error": r.get::<_, Option<String>>(11)?,
            }))
        };
        let it = match &bind {
            Some(s) => stmt.query_map([s], map_row).map_err(|e| e.to_string())?,
            None => stmt.query_map([], map_row).map_err(|e| e.to_string())?,
        };
        let out = it.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(json!(out))
    }

    pub fn get_quarantine_items_by_ids(&self, ids: &[i64]) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let mut stmt = self.conn
            .prepare("SELECT id, original_path, quarantine_path, session_dir, scan_root, file_name, file_size, sha256, quarantined_at, restored_at, status, operation_error FROM quarantine_items WHERE id = ?")
            .map_err(|e| e.to_string())?;
        for id in ids {
            if let Ok(v) = stmt.query_row([id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "original_path": r.get::<_, String>(1)?,
                    "quarantine_path": r.get::<_, String>(2)?, "session_dir": r.get::<_, String>(3)?,
                    "scan_root": r.get::<_, String>(4)?, "file_name": r.get::<_, String>(5)?,
                    "file_size": r.get::<_, i64>(6)?, "sha256": r.get::<_, Option<String>>(7)?,
                    "quarantined_at": r.get::<_, String>(8)?, "restored_at": r.get::<_, Option<String>>(9)?,
                    "status": r.get::<_, String>(10)?, "operation_error": r.get::<_, Option<String>>(11)?,
                }))
            }) {
                out.push(v);
            }
        }
        Ok(out)
    }

    pub fn mark_quarantine_items(
        &self, ids: &[i64], status: &str, restored_at: Option<&str>,
    ) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        let ra = restored_at.unwrap_or(&now).to_string();
        let sql = match status {
            "restored" => format!("UPDATE quarantine_items SET status = 'restored', restored_at = ? WHERE id IN ({placeholders})"),
            _ => format!("UPDATE quarantine_items SET status = ? WHERE id IN ({placeholders})"),
        };
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if status == "restored" {
            params_vec.push(Box::new(ra));
        } else {
            params_vec.push(Box::new(status.to_string()));
        }
        for i in ids {
            params_vec.push(Box::new(*i));
        }
        let refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
        self.conn
            .execute(&sql, refs.as_slice())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    // ---------- operation_logs ----------
    pub fn insert_operation_log(
        &self, operation_type: &str, target_path: Option<&str>,
        operation_status: &str, error_message: Option<&str>,
    ) -> Result<(), String> {
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        self.conn
            .execute(
                "INSERT INTO operation_logs (operation_type, target_path, operation_status, created_at, error_message) VALUES (?, ?, ?, ?, ?)",
                params![operation_type, target_path, operation_status, now, error_message],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn get_operation_logs(&self, limit: i64) -> Result<Value, String> {
        let limit = limit.clamp(1, 1000);
        let mut stmt = self.conn
            .prepare("SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?")
            .map_err(|e| e.to_string())?;
        let out = stmt
            .query_map([limit], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "operation_type": r.get::<_, String>(1)?,
                    "target_path": r.get::<_, Option<String>>(2)?, "operation_status": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, String>(4)?, "error_message": r.get::<_, Option<String>>(5)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(json!(out))
    }

    // ---------- 重置（scope: history | quarantine | all；规格 08：历史删除保留隔离区数据） ----------
    pub fn reset_app_data(&self, scope: &str) -> Result<Value, String> {
        if !["history", "quarantine", "all"].contains(&scope) {
            return Err("参数无效：scope 必须是 history | quarantine | all".into());
        }
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if scope == "history" || scope == "all" {
            for sql in [
                "DELETE FROM scanned_files",
                "DELETE FROM duplicate_groups",
                "DELETE FROM scan_roots",
                "DELETE FROM scan_sessions",
            ] {
                tx.execute(sql, []).map_err(|e| e.to_string())?;
            }
        }
        if scope == "quarantine" || scope == "all" {
            tx.execute("DELETE FROM quarantine_items", []).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.insert_operation_log("reset", None, "ok", None).ok();
        let count = |t: &str| -> i64 {
            self.conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap_or(0)
        };
        Ok(json!({
            "ok": true,
            "remaining": {
                "scan_sessions": count("scan_sessions"), "scanned_files": count("scanned_files"),
                "duplicate_groups": count("duplicate_groups"),
                "quarantine_items": count("quarantine_items"), "operation_logs": count("operation_logs"),
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU32, Ordering};
    static DB_SEQ: AtomicU32 = AtomicU32::new(0);
    fn tmpdb() -> Db {
        // 唯一文件名：并行测试不互撞（process id 相同）
        let n = DB_SEQ.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "cleandub-test-{}-{}.db", std::process::id(), n
        ));
        let _ = std::fs::remove_file(&p);
        Db::open(&p).unwrap()
    }

    #[test]
    fn schema_and_roundtrip() {
        let db = tmpdb();
        let sid = db.insert_scan_session("2026-01-01T00:00:00", "running").unwrap();
        db.insert_scan_roots(sid, &["C:/t".into()]).unwrap();
        let ids = db.insert_scanned_files(sid, &[ScannedFileRow {
            canonical_path: "C:/t/a.txt".into(), file_name: "a.txt".into(),
            extension: Some(".txt".into()), file_size: 10, modified_at: Some("t".into()),
            sha256: Some("ABC".into()), duplicate_group_id: None,
            scan_status: "ok".into(), error_message: None,
        }]).unwrap();
        assert_eq!(ids.len(), 1);
        db.complete_scan_session(sid, "completed", 1, 1, 1, 10, 5, None, "now").unwrap();
        let h = db.get_scan_history().unwrap();
        assert_eq!(h[0]["status"], "completed");
        assert_eq!(h[0]["roots"][0], "C:/t");
        let g = db.get_duplicate_groups(None).unwrap();
        assert_eq!(g["sessionId"], sid);
    }

    #[test]
    fn retention_and_protection() {
        let db = tmpdb();
        let sid = db.insert_scan_session("t", "completed").unwrap();
        let gid = db.insert_duplicate_group(sid, "H", 5).unwrap();
        let ids = db.insert_scanned_files(sid, &[
            ScannedFileRow { canonical_path: "C:/a/x (1).txt".into(), file_name: "x (1).txt".into(), extension: Some(".txt".into()), file_size: 5, modified_at: Some("2026-01-01T00:00:00".into()), sha256: Some("H".into()), duplicate_group_id: Some(gid), scan_status: "ok".into(), error_message: None },
            ScannedFileRow { canonical_path: "C:/a/x.txt".into(), file_name: "x.txt".into(), extension: Some(".txt".into()), file_size: 5, modified_at: Some("2025-01-01T00:00:00".into()), sha256: Some("H".into()), duplicate_group_id: Some(gid), scan_status: "ok".into(), error_message: None },
        ]).unwrap();
        let r = db.apply_retention_strategy(Some(sid), "Cleanest", None, true).unwrap();
        assert_eq!(r["groupsUpdated"], 1);
        let prot = db.get_protected_file_ids(&ids);
        assert!(prot.contains(&ids[1]), "x.txt（无后缀）应被保留");
        assert_eq!(prot.len(), 1);
    }

    #[test]
    fn reset_scopes() {
        let db = tmpdb();
        let sid = db.insert_scan_session("t", "completed").unwrap();
        let gid = db.insert_duplicate_group(sid, "H", 5).unwrap();
        db.insert_scanned_files(sid, &[ScannedFileRow {
            canonical_path: "p".into(), file_name: "p".into(), extension: None,
            file_size: 5, modified_at: None, sha256: None,
            duplicate_group_id: Some(gid), scan_status: "ok".into(), error_message: None,
        }]).unwrap();
        db.insert_quarantine_items(&[("o".into(), "s".into(), "d".into(), "r".into(), "n".into(), 5)]).unwrap();
        // history 重置：隔离数据保留
        let r = db.reset_app_data("history").unwrap();
        assert_eq!(r["remaining"]["quarantine_items"], 1);
        assert_eq!(r["remaining"]["scan_sessions"], 0);
        let r2 = db.reset_app_data("quarantine").unwrap();
        assert_eq!(r2["remaining"]["quarantine_items"], 0);
    }
}
