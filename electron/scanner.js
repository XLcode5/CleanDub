/**
 * 扫描引擎 —— 三段流水线（与 dedup_core.ps1 算法一致）：
 *   1) 枚举文件（跳过排除目录、符号链接、小于 minSize 的文件）
 *   2) 按文件大小分组（大小不同必不重复）
 *   3) 同大小组先读头部 32KB prehash 淘汰，幸存者再算全量 SHA-256（流式，1MB 缓冲）
 * 支持取消（AbortController 语义）、进度事件、错误逐文件记录（不中断整体扫描）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PREHASH_HEAD_BYTES = 32768;   // 与 dedup_core.ps1 的 $HeadBytes = 32768 一致
const HASH_BUFFER_SIZE = 1024 * 1024; // 1MB 流式缓冲，禁止整文件载入内存

// 与 dedup_core.ps1 $skipDirs 完全一致
const DEFAULT_EXCLUDE_DIRS = [
  '$RECYCLE.BIN', '$Recycle.Bin', 'System Volume Information',
  '.git', 'node_modules', '_dedup_quarantine', '_dedup_logs'
];

class CancelledError extends Error {
  constructor() { super('扫描已取消'); this.code = 'CANCELLED'; }
}

/**
 * 流式计算文件 SHA-256（或仅头部 headBytes 的 SHA-256）。
 * @param {string} filePath
 * @param {number} [headBytes] - >0 时只读头部；<=0 或缺省时全量
 * @returns {Promise<{hash: string, isFull: boolean}>}
 */
function hashFile(filePath, headBytes) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256');
    const opts = {};
    if (headBytes && headBytes > 0) opts.end = headBytes - 1;
    let resolved = false;
    const stream = fs.createReadStream(filePath, { ...opts, highWaterMark: HASH_BUFFER_SIZE });
    stream.on('error', reject);
    stream.on('data', (chunk) => sha.update(chunk));
    stream.on('end', () => {
      resolved = true;
      resolve({ hash: sha.digest('hex').toUpperCase(), isFull: true });
    });
    stream.on('close', () => { if (!resolved) reject(new Error('流提前关闭')); });
  });
}

class ScanManager {
  constructor({ db }) {
    this.db = db;
    /** @type {null | {cancelled: boolean, sessionId: number, progress: object, roots: string[]}} */
    this.current = null;
    this.emitter = null; // (channel, data) => void，由 ipc.js 注入
  }

  setEmitter(fn) { this.emitter = fn; }

  _emit(channel, data) { if (this.emitter) { try { this.emitter(channel, data); } catch {} } }

  isRunning() { return !!this.current; }

  getProgress() {
    if (this.current) return { state: 'running', ...this.current.progress };
    return { state: 'idle' };
  }

  cancel() {
    if (!this.current) return { ok: false, reason: '没有正在运行的扫描' };
    this.current.cancelled = true;
    return { ok: true };
  }

  abortIfRunning() { if (this.current) this.current.cancelled = true; }

  _updateProgress(patch) {
    if (!this.current) return;
    Object.assign(this.current.progress, patch);
    this._emit('scan-progress', { state: 'running', ...this.current.progress });
  }

  _checkCancel() {
    if (this.current && this.current.cancelled) throw new CancelledError();
  }

  /**
   * 启动扫描。同一时刻只允许一个扫描（防止快速重复点击）。
   * @param {string[]} roots - 扫描根目录数组（后端自行验证）
   * @param {{minSize?: number, excludeDirs?: string[], verify?: string}} [options]
   */
  async startScan(roots, options = {}) {
    if (this.current) {
      const err = new Error('已有扫描任务正在运行');
      err.code = 'ALREADY_RUNNING';
      throw err;
    }
    if (!Array.isArray(roots) || roots.length === 0) {
      throw new Error('至少选择一个扫描目录');
    }
    // 后端验证路径：规范化 + 必须是存在的目录
    const normRoots = [];
    for (const r of roots) {
      if (typeof r !== 'string' || !r.trim()) throw new Error('目录路径无效');
      const full = path.resolve(r.trim());
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || !stat.isDirectory()) throw new Error('目录不存在或不可访问: ' + full);
      normRoots.push(full);
    }
    const excludeDirs = new Set([...(options.excludeDirs || []), ...DEFAULT_EXCLUDE_DIRS]);
    const minSize = Number.isFinite(options.minSize) ? options.minSize : 1;
    // verify: Full（全量哈希，默认）/ Head（头部哈希）——Name/Size 不用于内容判重，仅保留兼容
    const verifyMode = options.verify === 'Head' ? 'Head' : 'Full';

    const startedAt = new Date();
    const sessionId = this.db.insertScanSession({
      started_at: startedAt.toISOString(),
      status: 'running'
    });
    this.db.insertScanRoots(sessionId, normRoots);

    this.current = {
      cancelled: false,
      sessionId,
      roots: normRoots,
      progress: {
        sessionId,
        phase: 'enumerate',
        message: '正在枚举文件…',
        current: 0,
        total: 0,
        percent: 0,
        elapsedSec: 0,
        scannedFiles: 0,
        errorCount: 0
      }
    };
    this._emit('scan-state', { state: 'running', sessionId });

    const t0 = Date.now();
    try {
      const result = await this._pipeline(normRoots, { minSize, excludeDirs, verifyMode, t0 });
      const completedAt = new Date();
      this.db.completeScanSession(sessionId, {
        completed_at: completedAt.toISOString(),
        status: 'completed',
        scanned_file_count: result.scannedFileCount,
        duplicate_group_count: result.groups.length,
        duplicate_file_count: result.duplicateFileCount,
        reclaimable_bytes: result.reclaimableBytes,
        duration_ms: Date.now() - t0,
        error_summary: result.errorCount > 0 ? `${result.errorCount} 个文件无法读取，已跳过` : null
      });
      this.current = null;
      const done = {
        state: 'completed',
        sessionId,
        ...result
      };
      this._emit('scan-state', done);
      return done;
    } catch (e) {
      const isCancel = e instanceof CancelledError || e.code === 'CANCELLED';
      this.db.completeScanSession(sessionId, {
        completed_at: new Date().toISOString(),
        status: isCancel ? 'cancelled' : 'failed',
        scanned_file_count: this.current ? this.current.progress.scannedFiles : 0,
        duplicate_group_count: 0,
        duplicate_file_count: 0,
        reclaimable_bytes: 0,
        duration_ms: Date.now() - t0,
        error_summary: isCancel ? '用户取消' : String(e.message || e)
      });
      this.current = null;
      const end = { state: isCancel ? 'cancelled' : 'failed', sessionId, error: String(e.message || e) };
      this._emit('scan-state', end);
      if (isCancel) return end;
      throw e;
    }
  }

  async _pipeline(roots, { minSize, excludeDirs, verifyMode, t0 }) {
    const batch = [];
    let scannedFileCount = 0;
    let errorCount = 0;
    let groupsInserted = 0;
    const sessionId = this.current.sessionId;

    const flushBatch = () => {
      if (batch.length === 0) return;
      this.db.insertScannedFiles(sessionId, batch);
      batch.length = 0;
    };

    // ---------- 阶段 1：枚举 + 按大小分组 ----------
    const sizeGroups = new Map(); // size -> fileInfo[]
    for (const root of roots) {
      this._checkCancel();
      this._updateProgress({ phase: 'enumerate', message: '枚举: ' + root });
      await this._enumerate(root, { minSize, excludeDirs, sizeGroups, onError: () => { errorCount++; }, onFile: () => {
        scannedFileCount++;
        if (scannedFileCount % 200 === 0) {
          this._updateProgress({
            phase: 'enumerate',
            message: `已枚举 ${scannedFileCount} 个文件`,
            current: scannedFileCount,
            elapsedSec: (Date.now() - t0) / 1000
          });
          this._checkCancel();
        }
      }});
    }
    this._checkCancel();

    // 大小分组后只剩单文件的组直接淘汰
    const candidates = [];
    for (const [size, files] of sizeGroups) {
      if (files.length > 1) candidates.push(...files.map(f => ({ ...f, size })));
    }

    // ---------- 阶段 2：prehash（头部 32KB） ----------
    const preGroups = new Map(); // size:headHash -> fileInfo[]
    let prehashed = 0;
    for (const fi of candidates) {
      this._checkCancel();
      try {
        const { hash } = await hashFile(fi.path, PREHASH_HEAD_BYTES);
        const key = fi.size + ':' + hash;
        if (!preGroups.has(key)) preGroups.set(key, []);
        preGroups.get(key).push(fi);
      } catch (e) {
        errorCount++;
        this.db.insertScannedFiles(sessionId, [{ ...this._row(fi), scan_status: 'error', error_message: String(e.message || e) }]);
      }
      prehashed++;
      if (prehashed % 100 === 0) {
        this._updateProgress({
          phase: 'prehash',
          message: `prehash ${prehashed}/${candidates.length}`,
          current: prehashed,
          total: candidates.length,
          percent: candidates.length ? Math.min(100, (prehashed * 100) / candidates.length) : 0,
          elapsedSec: (Date.now() - t0) / 1000
        });
      }
    }

    const survivors = [];
    for (const files of preGroups.values()) {
      if (files.length > 1) survivors.push(...files);
    }

    // ---------- 阶段 3：全量 SHA-256 分组 ----------
    const hashGroups = new Map(); // size:fullHash -> fileInfo[]
    let hashed = 0;
    for (const fi of survivors) {
      this._checkCancel();
      try {
        let fullHash;
        if (verifyMode === 'Head') {
          // Head 模式：直接复用头部哈希作为判重依据（速度快，精度略低）
          const { hash } = await hashFile(fi.path, PREHASH_HEAD_BYTES);
          fullHash = 'HEAD:' + hash;
        } else {
          const { hash } = await hashFile(fi.path);
          fullHash = hash;
        }
        const key = fi.size + ':' + fullHash;
        if (!hashGroups.has(key)) hashGroups.set(key, []);
        hashGroups.get(key).push({ ...fi, sha256: fullHash });
        batch.push({ ...this._row(fi), sha256: fullHash, scan_status: 'ok' });
      } catch (e) {
        errorCount++;
        batch.push({ ...this._row(fi), scan_status: 'error', error_message: String(e.message || e) });
      }
      hashed++;
      if (hashed % 50 === 0) {
        this._updateProgress({
          phase: 'hash',
          message: `全量哈希 ${hashed}/${survivors.length}`,
          current: hashed,
          total: survivors.length,
          percent: survivors.length ? Math.min(100, (hashed * 100) / survivors.length) : 0,
          elapsedSec: (Date.now() - t0) / 1000
        });
        flushBatch();
      }
    }
    flushBatch();

    // ---------- 阶段 4：写入重复组 ----------
    const groups = [];
    let duplicateFileCount = 0;
    let reclaimableBytes = 0;
    for (const [key, files] of hashGroups) {
      if (files.length < 2) continue;
      const sep = key.indexOf(':');
      const size = Number(key.slice(0, sep));
      const sha256 = key.slice(sep + 1);
      const groupId = this.db.insertDuplicateGroup(sessionId, { sha256, file_size: size });
      const fileIds = this.db.insertScannedFiles(sessionId, files.map(f => ({
        ...this._row(f), sha256: f.sha256, scan_status: 'ok', duplicate_group_id: groupId
      })));
      groupsInserted++;
      duplicateFileCount += files.length;
      reclaimableBytes += size * (files.length - 1);
      groups.push({
        id: groupId,
        sha256,
        fileSize: size,
        files: files.map((f, i) => ({
          id: fileIds[i],
          path: f.path,
          name: f.name,
          size,
          modifiedAt: f.mtime
        }))
      });
    }

    return {
      sessionId,
      scannedFileCount,
      errorCount,
      duplicateGroupCount: groupsInserted,
      duplicateFileCount,
      reclaimableBytes,
      groups,
      durationMs: Date.now() - t0
    };
  }

  _row(fi) {
    return {
      canonical_path: fi.path,
      file_name: fi.name,
      extension: path.extname(fi.name).toLowerCase(),
      file_size: fi.size,
      modified_at: new Date(fi.mtime).toISOString()
    };
  }

  /**
   * 递归枚举目录。跳过：排除目录、符号链接/重解析点、不可读目录、小于 minSize 的文件。
   */
  async _enumerate(dir, ctx, depth = 0) {
    if (depth > 64) return; // 防御性深度限制
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      ctx.onError();
      return;
    }
    for (const ent of entries) {
      this._checkCancel();
      const full = path.join(dir, ent.name);
      try {
        if (ent.isSymbolicLink()) continue; // 符号链接策略：不跟随（规格 09-17）
        if (ent.isDirectory()) {
          if (ctx.excludeDirs.has(ent.name)) continue;
          await this._enumerate(full, ctx, depth + 1);
        } else if (ent.isFile()) {
          const st = await fsp.stat(full).catch(() => null);
          if (!st) { ctx.onError(); continue; }
          if (st.size < ctx.minSize) continue;
          if (!ctx.sizeGroups.has(st.size)) ctx.sizeGroups.set(st.size, []);
          ctx.sizeGroups.get(st.size).push({ path: full, name: ent.name, size: st.size, mtime: st.mtimeMs });
          ctx.onFile();
        }
      } catch {
        ctx.onError();
      }
    }
  }
}

module.exports = { ScanManager, hashFile, CancelledError, DEFAULT_EXCLUDE_DIRS, PREHASH_HEAD_BYTES };
