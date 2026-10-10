/**
 * 数据持久化 —— SQLite（better-sqlite3 若可用，否则退回 node:sqlite 内置模块）。
 * 表结构与 docs/cleandub-ui/08-data-model.md 对齐：
 *   scan_sessions / scan_roots / scanned_files / duplicate_groups / quarantine_items / operation_logs
 * 所有多步写入使用事务；写入失败时抛出，调用方不得继续危险操作（规格 08）。
 */
const path = require('path');
const fs = require('fs');

let Database = null;
let driver = 'better-sqlite3';
try {
  Database = require('better-sqlite3');
} catch {
  // Electron ≥33 / Node ≥22 内置 node:sqlite（同步 API，够用且零依赖）
  try {
    ({ DatabaseSync: Database } = require('node:sqlite'));
    driver = 'node:sqlite';
  } catch {
    throw new Error('无可用 SQLite 驱动：请安装 better-sqlite3，或使用 Node ≥22 / Electron ≥33');
  }
}

const SCHEMA = `
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
`;

class Db {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
  }

  init() {
    this.db.exec(SCHEMA);
  }

  close() {
    try { this.db.close(); } catch {}
  }

  // ---------- scan_sessions ----------
  insertScanSession({ started_at, status }) {
    const stmt = this.db.prepare(
      'INSERT INTO scan_sessions (started_at, status) VALUES (?, ?)'
    );
    const info = stmt.run(started_at, status);
    return Number(info.lastInsertRowid);
  }

  completeScanSession(id, fields) {
    const stmt = this.db.prepare(`
      UPDATE scan_sessions SET
        completed_at = ?, status = ?, scanned_file_count = ?, duplicate_group_count = ?,
        duplicate_file_count = ?, reclaimable_bytes = ?, duration_ms = ?, error_summary = ?
      WHERE id = ?`);
    stmt.run(
      fields.completed_at, fields.status, fields.scanned_file_count,
      fields.duplicate_group_count, fields.duplicate_file_count,
      fields.reclaimable_bytes, fields.duration_ms, fields.error_summary || null, id
    );
  }

  insertScanRoots(sessionId, roots) {
    const stmt = this.db.prepare('INSERT INTO scan_roots (scan_session_id, directory_path) VALUES (?, ?)');
    this.transaction(() => { for (const r of roots) stmt.run(sessionId, r); });
  }

  insertScannedFiles(sessionId, rows) {
    if (!rows || rows.length === 0) return [];
    const stmt = this.db.prepare(`
      INSERT INTO scanned_files
        (scan_session_id, duplicate_group_id, canonical_path, file_name, extension, file_size, modified_at, sha256, scan_status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = [];
    this.transaction(() => {
      for (const r of rows) {
        const info = stmt.run(
          sessionId,
          r.duplicate_group_id || null,
          r.canonical_path, r.file_name, r.extension || '',
          r.file_size, r.modified_at || null,
          r.sha256 || null, r.scan_status || 'ok', r.error_message || null
        );
        ids.push(Number(info.lastInsertRowid));
      }
    });
    return ids;
  }

  insertDuplicateGroup(sessionId, { sha256, file_size }) {
    const info = this.db.prepare(
      'INSERT INTO duplicate_groups (scan_session_id, sha256, file_size) VALUES (?, ?, ?)'
    ).run(sessionId, sha256, file_size);
    return Number(info.lastInsertRowid);
  }

  getScanHistory() {
    const sessions = this.db.prepare(`
      SELECT id, started_at, completed_at, status, scanned_file_count,
             duplicate_group_count, duplicate_file_count, reclaimable_bytes,
             duration_ms, error_summary
      FROM scan_sessions ORDER BY id DESC`).all();
    const rootsStmt = this.db.prepare('SELECT directory_path FROM scan_roots WHERE scan_session_id = ?');
    return sessions.map(s => ({
      ...s,
      roots: rootsStmt.all(s.id).map(r => r.directory_path)
    }));
  }

  getDuplicateGroups(sessionId) {
    const sid = sessionId || (() => {
      const row = this.db.prepare(
        "SELECT id FROM scan_sessions WHERE status IN ('completed','cancelled') ORDER BY id DESC LIMIT 1"
      ).get();
      return row ? row.id : null;
    })();
    if (!sid) return { sessionId: null, groups: [] };
    const groups = this.db.prepare(
      'SELECT id, sha256, file_size, retained_file_id FROM duplicate_groups WHERE scan_session_id = ? ORDER BY file_size DESC'
    ).all(sid);
    const filesStmt = this.db.prepare(
      'SELECT id, canonical_path, file_name, file_size, modified_at, sha256 FROM scanned_files WHERE duplicate_group_id = ? ORDER BY canonical_path'
    );
    return {
      sessionId: sid,
      groups: groups.map(g => ({ ...g, files: filesStmt.all(g.id) }))
    };
  }

  setRetainedFile(groupId, fileId) {
    // 校验：fileId 必须属于该组，防止前端乱提交
    const row = this.db.prepare(
      'SELECT id FROM scanned_files WHERE id = ? AND duplicate_group_id = ?'
    ).get(fileId, groupId);
    if (!row) throw new Error('文件不属于该重复组');
    this.db.prepare('UPDATE duplicate_groups SET retained_file_id = ? WHERE id = ?').run(fileId, groupId);
    return { ok: true };
  }

  deleteScanHistory(sessionId) {
    // 规格 08：删除历史保留隔离区恢复所需数据 —— quarantine_items 不随扫描删除
    this.transaction(() => {
      this.db.prepare('DELETE FROM scanned_files WHERE scan_session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM duplicate_groups WHERE scan_session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM scan_roots WHERE scan_session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM scan_sessions WHERE id = ?').run(sessionId);
    });
    return { ok: true };
  }

  // ---------- quarantine_items ----------
  insertQuarantineItems(items) {
    const stmt = this.db.prepare(`
      INSERT INTO quarantine_items
        (original_path, quarantine_path, session_dir, scan_root, file_name, file_size, sha256, quarantined_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quarantined')`);
    this.transaction(() => {
      for (const it of items) {
        stmt.run(it.original_path, it.quarantine_path, it.session_dir, it.scan_root,
          it.file_name, it.file_size, it.sha256 || null, it.quarantined_at);
      }
    });
  }

  getQuarantineItems(status) {
    if (status) {
      return this.db.prepare('SELECT * FROM quarantine_items WHERE status = ? ORDER BY id DESC').all(status);
    }
    return this.db.prepare('SELECT * FROM quarantine_items ORDER BY id DESC').all();
  }

  markQuarantineItems(ids, status, extra = {}) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const sets = ['status = ?'];
    const values = [status];
    if (extra.restored_at) { sets.push('restored_at = ?'); values.push(extra.restored_at); }
    if (extra.operation_error !== undefined) { sets.push('operation_error = ?'); values.push(extra.operation_error); }
    this.db.prepare(
      `UPDATE quarantine_items SET ${sets.join(', ')} WHERE id IN (${placeholders})`
    ).run(...values, ...ids);
  }

  // ---------- operation_logs ----------
  insertOperationLog({ operation_type, target_path, operation_status, error_message }) {
    this.db.prepare(
      'INSERT INTO operation_logs (operation_type, target_path, operation_status, created_at, error_message) VALUES (?, ?, ?, ?, ?)'
    ).run(operation_type, target_path || null, operation_status || 'ok',
      new Date().toISOString(), error_message || null);
  }

  getOperationLogs(limit = 200) {
    return this.db.prepare(
      'SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?'
    ).all(Math.min(Math.max(1, limit), 1000));
  }

  // ---------- 事务 ----------
  transaction(fn) {
    // better-sqlite3 提供 .transaction；node:sqlite 用手动 BEGIN/COMMIT
    if (typeof this.db.transaction === 'function') {
      return this.db.transaction(fn)();
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
}

module.exports = { Db, driver };
