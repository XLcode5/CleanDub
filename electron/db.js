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
  // 探测必须做实例化：require 成功不代表 ABI 匹配（.node 二进制在实例化时才 dlopen）。
  // 预编译二进制可能是 Electron 版（ABI 130），在纯 Node（ABI 147）下 require 成功但 new 失败。
  const probe = new Database(':memory:');
  probe.exec('CREATE TABLE _probe(a)');
  probe.close();
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

// ---------- 保留策略辅助（对齐 dedup_core.ps1 Get-Keeper2 / Get-SuffixMarkerInfo） ----------
// 提取 basename 中的 "(N)" 后缀标记个数与最大数字；与 PS 版正则保持一致
function suffixMarkerInfo(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, ''); // 去扩展名
  const matches = base.match(/\(\d+\)/g);
  const count = matches ? matches.length : 0;
  let maxN = 0;
  const tail = base.match(/\((\d+)\)\s*$/);
  if (tail) maxN = parseInt(tail[1], 10) || 0;
  const hasTrailing = /\s*\(\d+\)\s*$/.test(base);
  return { count, maxN, hasTrailing };
}

function mtimeOf(f) {
  const t = Date.parse(f.modified_at || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * 从一组重复文件中按策略选出 keeper。
 * @param {Array<{id:number, canonical_path:string, file_name:string, modified_at:string}>} files
 * @param {'Cleanest'|'Newest'|'Original'|'Highest'} strategy
 */
function pickKeeper(files, strategy) {
  if (!files || files.length === 0) return null;
  if (files.length === 1) return files[0];
  const enriched = files.map(f => ({ ...f, _mi: suffixMarkerInfo(f.file_name) }));
  if (strategy === 'Highest') {
    enriched.sort((a, b) =>
      (b._mi.maxN - a._mi.maxN) ||
      (mtimeOf(b) - mtimeOf(a))
    );
    return enriched[0];
  }
  if (strategy === 'Original') {
    const plain = enriched.filter(f => !f._mi.hasTrailing);
    if (plain.length > 0) {
      plain.sort((a, b) => mtimeOf(b) - mtimeOf(a));
      return plain[0];
    }
    // 都带后缀 → 退回 Newest
    enriched.sort((a, b) => mtimeOf(b) - mtimeOf(a));
    return enriched[0];
  }
  if (strategy === 'Newest') {
    enriched.sort((a, b) => mtimeOf(b) - mtimeOf(a));
    return enriched[0];
  }
  // Cleanest (默认): (N) 个数最少 → mtime 最新 → 路径最短
  enriched.sort((a, b) =>
    (a._mi.count - b._mi.count) ||
    (mtimeOf(b) - mtimeOf(a)) ||
    (String(a.canonical_path).length - String(b.canonical_path).length)
  );
  return enriched[0];
}

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

  /**
   * 批量保留策略：对某次扫描的所有重复组一次性选定 retained_file_id。
   * 策略语义对齐 dedup_core.ps1 Get-Keeper2：
   *   Cleanest —— (N) 标记最少优先；并列比修改时间新；再并列比路径短
   *   Newest   —— 修改时间最新
   *   Original —— 无 (N) 后缀原件优先（并列取最新）；都带后缀时退回 Newest
   *   Highest  —— (N) 数字最大优先；并列比修改时间新
   * @param {number|null} sessionId - 缺省取最近一次 completed/cancelled 会话
   * @param {string} strategy
   * @returns {{sessionId: number, strategy: string, groupsUpdated: number}}
   */
  applyRetentionStrategy(sessionId, strategy) {
    const sid = sessionId || (() => {
      const row = this.db.prepare(
        "SELECT id FROM scan_sessions WHERE status IN ('completed','cancelled') ORDER BY id DESC LIMIT 1"
      ).get();
      return row ? row.id : null;
    })();
    if (!sid) throw new Error('没有可用的扫描会话');
    const strat = ['Cleanest', 'Newest', 'Original', 'Highest'].includes(strategy) ? strategy : 'Cleanest';
    const groups = this.db.prepare(
      'SELECT id FROM duplicate_groups WHERE scan_session_id = ?'
    ).all(sid);
    const filesStmt = this.db.prepare(
      'SELECT id, canonical_path, file_name, modified_at FROM scanned_files WHERE duplicate_group_id = ?'
    );
    const updateStmt = this.db.prepare(
      'UPDATE duplicate_groups SET retained_file_id = ? WHERE id = ?'
    );
    let updated = 0;
    this.transaction(() => {
      for (const g of groups) {
        const files = filesStmt.all(g.id);
        if (!files || files.length === 0) continue;
        const keeper = pickKeeper(files, strat);
        if (keeper) { updateStmt.run(keeper.id, g.id); updated++; }
      }
    });
    return { sessionId: sid, strategy: strat, groupsUpdated: updated };
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

  /**
   * 数据管理一键重置（个人中心「数据管理」卡片）。
   * scope:
   *   - history   清空扫描历史（sessions/roots/scanned_files/duplicate_groups）
   *   - quarantine 清空隔离区【记录】（quarantine_items + operation_logs；磁盘实体不删——
   *               实体目录在扫描根/自定义位置，应用不掌握全部根的写权限，需用户自行处理）
   *   - all       两者全清
   * 返回各表剩余行数，供 UI 核对。
   */
  resetAppData(scope) {
    const s = scope === 'history' || scope === 'quarantine' || scope === 'all' ? scope : null;
    if (!s) throw new Error('参数无效');
    this.transaction(() => {
      if (s === 'history' || s === 'all') {
        this.db.prepare('DELETE FROM scanned_files').run();
        this.db.prepare('DELETE FROM duplicate_groups').run();
        this.db.prepare('DELETE FROM scan_roots').run();
        this.db.prepare('DELETE FROM scan_sessions').run();
      }
      if (s === 'quarantine' || s === 'all') {
        this.db.prepare('DELETE FROM quarantine_items').run();
      }
      this.db.prepare('DELETE FROM operation_logs').run();
    });
    const count = (t) => Number(this.db.prepare(`SELECT COUNT(*) FROM ${t}`).get()['COUNT(*)']);
    return {
      ok: true,
      remaining: {
        scan_sessions: count('scan_sessions'),
        scanned_files: count('scanned_files'),
        duplicate_groups: count('duplicate_groups'),
        quarantine_items: count('quarantine_items'),
        operation_logs: count('operation_logs')
      }
    };
  }

  // ---------- IPC 适配辅助（渲染层提交 id，引擎层需要 path/session） ----------
  getFilesByIds(ids) {
    const out = [];
    const stmt = this.db.prepare(
      'SELECT id, canonical_path, file_name, file_size FROM scanned_files WHERE id = ?'
    );
    for (const id of ids) {
      const row = stmt.get(id);
      if (row) out.push(row);
    }
    return out;
  }

  scanRootOfFile(fileId) {
    const row = this.db.prepare(`
      SELECT r.directory_path AS root FROM scanned_files f
      JOIN scan_roots r ON r.scan_session_id = f.scan_session_id
      WHERE f.id = ? LIMIT 1`).get(fileId);
    return row ? row.root : null;
  }

  getQuarantineItemsByIds(ids) {
    const out = [];
    const stmt = this.db.prepare(
      'SELECT id, original_path, quarantine_path, session_dir, scan_root, status FROM quarantine_items WHERE id = ?'
    );
    for (const id of ids) {
      const row = stmt.get(id);
      if (row) out.push(row);
    }
    return out;
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

module.exports = { Db, driver, pickKeeper, suffixMarkerInfo };
