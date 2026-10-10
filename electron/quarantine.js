/**
 * 隔离区管理 —— 与 dedup_core.ps1 / QuarantineManager.cs 双向兼容。
 *
 * 磁盘格式（逐字节兼容）：
 *   <scanRoot>/_dedup_quarantine/<yyyyMMdd_HHmmss>-<6位随机>/manifest.json
 *     manifest: { "scanRoot": ..., "createdAt": "<ISO 's'>", "files": [
 *       { "original": <原路径>, "stored": <隔离路径>, "size": <字节>, "movedAt": "<ISO 's'>" } ] }
 *   <scanRoot>/_dedup_logs/ops.jsonl   —— append-only JSONL 操作日志
 *
 * 安全规则（docs/09）：
 *   - 所有路径先 path.resolve + 验证在扫描根内（大小写不敏感，Windows）
 *   - 操作前复查文件存在；Move 失败回退 Copy+校验大小+Delete
 *   - 还原时来源必须在隔离区 session 内；目标已存在则追加 .restored 后缀
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function isoNow() {
  // 对齐 .NET DateTime.ToString("s")："yyyy-MM-ddTHH:mm:ss"（本地时间，无时区后缀）
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sessionDirName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`; // 6 位随机
}

function normalizeRoot(p) {
  // 对齐 C# Path.GetFullPath(p.Trim().TrimEnd('\\','/'))
  return path.resolve(String(p).trim().replace(/[\\/]+$/, ''));
}

function isUnder(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c.toLowerCase().startsWith(p.toLowerCase() + path.sep);
}

class Quarantine {
  constructor({ db, customDir }) {
    this.db = db;
    // 自定义隔离区位置：设置后所有扫描共用（规格 7.6「隔离区位置」）；空 = 各扫描根下默认目录
    this.customDir = customDir && String(customDir).trim() ? String(customDir).trim() : null;
  }

  quarantineRoot(scanRoot) {
    if (this.customDir) return this.customDir;
    return path.join(normalizeRoot(scanRoot), '_dedup_quarantine');
  }
  logsRoot(scanRoot) { return path.join(normalizeRoot(scanRoot), '_dedup_logs'); }

  /**
   * 追加一条 ops.jsonl（与 Write-OpRecord2 相同：UTF-8 无 BOM、紧凑 JSON、每行一条）。
   * 日志写入失败只返回错误，不阻断主流程；但文件操作本身失败必须上报。
   */
  async appendOpLog(scanRoot, record) {
    try {
      const dir = this.logsRoot(scanRoot);
      await fsp.mkdir(dir, { recursive: true });
      const line = JSON.stringify(record) + '\n';
      await fsp.appendFile(path.join(dir, 'ops.jsonl'), line, 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /** Move 失败回退 Copy + 校验大小 + Delete（规格 09-10/11/12）。 */
  async _moveWithFallback(src, dest, expectedSize) {
    try {
      await fsp.rename(src, dest);
      return;
    } catch {
      // 跨磁盘或占用 → 复制 + 校验 + 删除
      await fsp.copyFile(src, dest);
      const [s1, s2] = await Promise.all([fsp.stat(src), fsp.stat(dest)]);
      if (s1.size !== s2.size || (expectedSize != null && s2.size !== expectedSize)) {
        // 校验失败：删除半成品副本，绝不删源文件
        await fsp.unlink(dest).catch(() => {});
        throw new Error('跨磁盘复制校验失败，已保留原文件');
      }
      await fsp.unlink(src);
    }
  }

  async _uniquePath(dest) {
    let final = dest;
    for (let i = 1; ; i++) {
      try { await fsp.access(final); final = dest + '.' + i; }
      catch { return final; }
    }
  }

  /**
   * 移入隔离区。
   * @param {string} scanRoot
   * @param {Array<{path: string, size?: number, sha256?: string}>} files
   */
  async moveToQuarantine(scanRoot, files) {
    const root = normalizeRoot(scanRoot);
    if (!Array.isArray(files) || files.length === 0) throw new Error('没有需要隔离的文件');
    const session = path.join(this.quarantineRoot(root), sessionDirName());
    const entries = [];
    const failures = [];
    let moved = 0;
    let bytes = 0;

    for (const f of files) {
      let full;
      try { full = path.resolve(String(f.path)); }
      catch { failures.push({ path: String(f.path), reason: '路径无效' }); continue; }

      if (!isUnder(full, root)) { failures.push({ path: full, reason: '不在扫描根目录内，已拒绝' }); continue; }
      // 拒绝把隔离区/日志区里的文件再次"隔离"
      if (isUnder(full, this.quarantineRoot(root)) || isUnder(full, this.logsRoot(root))) {
        failures.push({ path: full, reason: '文件位于隔离区/日志区，已拒绝' }); continue;
      }
      let st;
      try { st = await fsp.stat(full); }
      catch { failures.push({ path: full, reason: '文件不存在（可能已被处理）' }); continue; }
      // 若扫描后文件大小变化，以当前实际大小为准（规格 09-16）
      const size = st.size;

      const rel = path.relative(root, full) || path.basename(full);
      const dest = await this._uniquePath(path.join(session, rel));
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await this._moveWithFallback(full, dest, size);
        entries.push({ original: full, stored: dest, size, movedAt: isoNow() });
        moved++;
        bytes += size;
      } catch (e) {
        failures.push({ path: full, reason: String(e.message || e) });
      }
    }

    if (entries.length > 0) {
      await fsp.mkdir(session, { recursive: true });
      // manifest 格式与 QuarantineManager.cs WriteManifest 完全一致（UTF-8 无 BOM、紧凑 JSON）
      const manifest = { scanRoot: root, createdAt: isoNow(), files: entries };
      await fsp.writeFile(path.join(session, 'manifest.json'), JSON.stringify(manifest), 'utf8');
      // 持久化到 SQLite（历史/统计用；磁盘 manifest 是兼容权威源）
      this.db.insertQuarantineItems(entries.map(e => ({
        original_path: e.original,
        quarantine_path: e.stored,
        session_dir: session,
        scan_root: root,
        file_name: path.basename(e.original),
        file_size: e.size,
        quarantined_at: e.movedAt
      })));
      await this.appendOpLog(root, {
        op: 'quarantine', ts: isoNow(), root, session,
        moved, bytes, failedCount: failures.length,
        detail: `移入隔离区 ${moved} 个 / ${bytes} B，失败 ${failures.length}`
      });
      this.db.insertOperationLog({
        operation_type: 'quarantine',
        target_path: root,
        operation_status: failures.length ? 'partial' : 'ok',
        error_message: failures.length ? JSON.stringify(failures.slice(0, 20)) : null
      });
    }
    return { session, moved, bytes, failures };
  }

  /** 读取隔离区会话（解析磁盘 manifest，与 PowerShell 版双向兼容）。 */
  async loadSessions(scanRoot) {
    const root = normalizeRoot(scanRoot);
    const qroot = this.quarantineRoot(root);
    const out = [];
    let dirs = [];
    try { dirs = await fsp.readdir(qroot, { withFileTypes: true }); }
    catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(qroot, d.name);
      const mf = path.join(dir, 'manifest.json');
      try {
        const doc = JSON.parse(await fsp.readFile(mf, 'utf8'));
        const files = Array.isArray(doc.files) ? doc.files
          .filter(e => e && typeof e.stored === 'string' && e.stored)
          .map(e => ({
            original: String(e.original || ''),
            stored: String(e.stored || ''),
            size: Number(e.size) || 0,
            movedAt: String(e.movedAt || '')
          })) : [];
        out.push({
          name: d.name,
          path: dir,
          createdAt: String(doc.createdAt || ''),
          files,
          fileCount: files.length,
          bytes: files.reduce((a, b) => a + b.size, 0)
        });
      } catch { /* 跳过损坏 session */ }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  /**
   * 还原条目到原始路径；目标已存在追加 .restored。
   * @param {string} sessionDir - 必须是 <scanRoot>/_dedup_quarantine 的直接子目录
   * @param {Array<{original: string, stored: string}>} entries
   */
  async restore(scanRoot, sessionDir, entries) {
    const root = normalizeRoot(scanRoot);
    const sessFull = path.resolve(String(sessionDir));
    const qroot = this.quarantineRoot(root);
    // 安全：session 必须是隔离根的直接子目录（对齐 Test-QuarantineSessionPath2）
    if (path.dirname(sessFull).toLowerCase() !== qroot.toLowerCase()) {
      throw new Error('隔离会话路径非法');
    }
    const failures = [];
    let moved = 0, bytes = 0;
    const restoredStored = [];

    for (const e of entries) {
      let storedFull;
      try { storedFull = path.resolve(String(e.stored)); }
      catch { failures.push({ path: String(e.original), reason: '路径无效' }); continue; }
      if (!isUnder(storedFull, sessFull)) { failures.push({ path: String(e.stored), reason: '不在隔离区内，已拒绝还原' }); continue; }
      try { await fsp.access(storedFull); }
      catch { failures.push({ path: String(e.original), reason: '隔离区内文件已不存在' }); continue; }

      let target = path.resolve(String(e.original));
      try { await fsp.access(target); target = target + '.restored'; } catch {}
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await this._moveWithFallback(storedFull, target, null);
        moved++;
        bytes += Number(e.size) || 0;
        restoredStored.push(storedFull);
      } catch (err) {
        failures.push({ path: String(e.original), reason: String(err.message || err) });
      }
    }

    await this._rewriteManifest(sessFull, restoredStored);
    await this.appendOpLog(root, {
      op: 'quarantine-restore', ts: isoNow(), root, session: sessFull,
      restored: moved, bytes, failedCount: failures.length,
      detail: `还原 ${moved} 个，失败 ${failures.length}`
    });
    this.db.insertOperationLog({
      operation_type: 'restore', target_path: sessFull,
      operation_status: failures.length ? 'partial' : 'ok',
      error_message: failures.length ? JSON.stringify(failures.slice(0, 20)) : null
    });
    // 返回成功条目的 stored 路径，让调用方按需精准更新 SQLite 状态
    return { restored: moved, bytes, failures, succeededStored: restoredStored };
  }

  /** 永久删除隔离区条目（调用方须已二次确认）。 */
  async deletePermanent(scanRoot, sessionDir, entries) {
    const root = normalizeRoot(scanRoot);
    const sessFull = path.resolve(String(sessionDir));
    const qroot = this.quarantineRoot(root);
    if (path.dirname(sessFull).toLowerCase() !== qroot.toLowerCase()) {
      throw new Error('隔离会话路径非法');
    }
    const failures = [];
    let deleted = 0, bytes = 0;
    const removedStored = [];

    for (const e of entries) {
      let storedFull;
      try { storedFull = path.resolve(String(e.stored)); }
      catch { failures.push({ path: String(e.original), reason: '路径无效' }); continue; }
      if (!isUnder(storedFull, sessFull)) { failures.push({ path: String(e.stored), reason: '不在隔离区内，已拒绝删除' }); continue; }
      try {
        await fsp.unlink(storedFull);
        deleted++;
        bytes += Number(e.size) || 0;
        removedStored.push(storedFull);
      } catch (err) {
        failures.push({ path: String(e.stored), reason: String(err.message || err) });
      }
    }

    await this._rewriteManifest(sessFull, removedStored);
    await this.appendOpLog(root, {
      op: 'quarantine-delete', ts: isoNow(), root, session: sessFull,
      deleted, bytes, failedCount: failures.length,
      detail: `永久删除 ${deleted} 个，失败 ${failures.length}`
    });
    this.db.insertOperationLog({
      operation_type: 'delete', target_path: sessFull,
      operation_status: failures.length ? 'partial' : 'ok',
      error_message: failures.length ? JSON.stringify(failures.slice(0, 20)) : null
    });
    // 返回成功条目的 stored 路径，让调用方按需精准更新 SQLite 状态
    return { deleted, bytes, failures, succeededStored: removedStored };
  }

  /** 部分处理后回写 manifest（剔除已移除条目）；会话空了就删除整个目录。 */
  async _rewriteManifest(sessFull, removedStoredPaths) {
    const mf = path.join(sessFull, 'manifest.json');
    let doc;
    try { doc = JSON.parse(await fsp.readFile(mf, 'utf8')); }
    catch { return; }
    const removed = new Set(removedStoredPaths.map(p => path.resolve(p).toLowerCase()));
    const remaining = (Array.isArray(doc.files) ? doc.files : [])
      .filter(e => e && e.stored && !removed.has(path.resolve(String(e.stored)).toLowerCase()));
    if (remaining.length === 0) {
      await fsp.rm(sessFull, { recursive: true, force: true }).catch(() => {});
      return;
    }
    doc.files = remaining;
    await fsp.writeFile(mf, JSON.stringify(doc), 'utf8');
  }
}

module.exports = { Quarantine, isoNow, sessionDirName, normalizeRoot };
