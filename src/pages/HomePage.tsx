import {
  FolderOpen,
  FolderPlus,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  X,
  Zap
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isDemoMode, onScanProgress, onScanState } from '../bridge';
import { Card } from '../components/Card';
import { DemoBadge, DemoBanner } from '../components/DemoBadge';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { useToast } from '../components/Toast';
import type { AppSettings, ScanHistoryEntry, ScanProgress, ScanState, ScanStateEvent } from '../types';
import { formatBytes, formatCount, formatDuration, formatRelative, truncatePath } from '../utils';

interface HomePageProps {
  onNavigateToCleanup: () => void;
}

interface ScanStats {
  sessionId: number | null;
  scannedFileCount: number;
  duplicateGroupCount: number;
  duplicateFileCount: number;
  reclaimableBytes: number;
  durationMs: number;
  lastScanAt: string | null;
}

const INITIAL_STATS: ScanStats = {
  sessionId: null,
  scannedFileCount: 0,
  duplicateGroupCount: 0,
  duplicateFileCount: 0,
  reclaimableBytes: 0,
  durationMs: 0,
  lastScanAt: null
};

export function HomePage({ onNavigateToCleanup }: HomePageProps) {
  const toast = useToast();
  const [directories, setDirectories] = useState<string[]>([]);
  const [state, setState] = useState<ScanState>('idle');
  const [progress, setProgress] = useState<ScanProgress>({ state: 'idle' });
  const [stats, setStats] = useState<ScanStats>(INITIAL_STATS);
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const mountedRef = useRef(true);

  // ---------- 扫描选项（持久化到 update-app-settings） ----------
  const [verify, setVerify] = useState<AppSettings['verify']>('Full');
  const [recurse, setRecurse] = useState<boolean>(true);
  const [detectLinks, setDetectLinks] = useState<boolean>(false);
  const [excludeDirs, setExcludeDirs] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState('');
  const settingsLoadedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 启动时加载最近一次扫描结果
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await invoke('get-scan-history');
        if (cancelled) return;
        const latest = history.find(
          (h: ScanHistoryEntry) => h.status === 'completed' || h.status === 'cancelled'
        );
        if (latest) {
          setStats({
            sessionId: latest.id,
            scannedFileCount: latest.scanned_file_count,
            duplicateGroupCount: latest.duplicate_group_count,
            duplicateFileCount: latest.duplicate_file_count,
            reclaimableBytes: latest.reclaimable_bytes,
            durationMs: latest.duration_ms,
            lastScanAt: latest.completed_at ?? latest.started_at
          });
        }
      } catch (e) {
        // 首次运行没有历史是合法的
        if (!cancelled) console.warn('加载扫描历史失败', e);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 启动时加载已保存的扫描选项
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await invoke('get-app-settings');
        if (cancelled || !s) return;
        if (s.verify) setVerify(s.verify);
        if (typeof s.recurse === 'boolean') setRecurse(s.recurse);
        if (typeof s.detectLinks === 'boolean') setDetectLinks(s.detectLinks);
        if (Array.isArray(s.excludeDirs)) setExcludeDirs(s.excludeDirs);
      } catch (e) {
        if (!cancelled) console.warn('加载应用设置失败', e);
      } finally {
        if (!cancelled) settingsLoadedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 选项变更后持久化（仅在初始加载完成后）
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    invoke('update-app-settings', { verify, recurse, detectLinks, excludeDirs }).catch(e => {
      console.warn('保存扫描选项失败', e);
    });
  }, [verify, recurse, detectLinks, excludeDirs]);

  // 订阅扫描事件
  useEffect(() => {
    const offP = onScanProgress(p => {
      if (!mountedRef.current) return;
      setProgress(p);
      setState(p.state);
    });
    const offS = onScanState((s: ScanStateEvent) => {
      if (!mountedRef.current) return;
      setState(s.state);
      if (s.state === 'completed') {
        setStats({
          sessionId: s.sessionId ?? null,
          scannedFileCount: s.scannedFileCount ?? 0,
          duplicateGroupCount: s.duplicateGroupCount ?? 0,
          duplicateFileCount: s.duplicateFileCount ?? 0,
          reclaimableBytes: s.reclaimableBytes ?? 0,
          durationMs: s.durationMs ?? 0,
          lastScanAt: new Date().toISOString()
        });
        toast.success('扫描已完成');
      } else if (s.state === 'cancelled') {
        toast.info('扫描已取消');
      } else if (s.state === 'failed') {
        setError(s.error ?? '扫描失败');
        toast.error(s.error ?? '扫描失败');
      }
    });
    return () => { offP(); offS(); };
  }, [toast]);

  const handleChooseDir = useCallback(async () => {
    try {
      const r = await invoke('choose-directories');
      const paths = (r as { paths?: string[] }).paths ?? [];
      if (paths.length === 0) return;
      setDirectories(prev => {
        const next = [...prev];
        for (const p of paths) {
          if (!next.includes(p)) next.push(p);
        }
        return next;
      });
    } catch (e) {
      toast.error('选择目录失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [toast]);

  const handleRemoveDir = useCallback((dir: string) => {
    setDirectories(prev => prev.filter(d => d !== dir));
  }, []);

  const handleStartScan = useCallback(async () => {
    if (directories.length === 0) {
      toast.warn('请先添加至少一个扫描目录');
      return;
    }
    setError(null);
    setState('running');
    try {
      // 主进程当前实现可能只识别 verify/excludeDirs/minSize；
      // recurse/detectLinks 字段未来接入，先一并传过去（主进程忽略即可）。
      await invoke('start-scan', {
        roots: directories,
        options: {
          verify,
          excludeDirs,
          recurse,
          detectLinks
        }
      });
    } catch (e) {
      setState('failed');
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(msg);
    }
  }, [directories, verify, excludeDirs, recurse, detectLinks, toast]);

  const handleAddExcludeDir = useCallback(() => {
    const v = excludeInput.trim();
    if (!v) return;
    setExcludeDirs(prev => (prev.includes(v) ? prev : [...prev, v]));
    setExcludeInput('');
  }, [excludeInput]);

  const handleRemoveExcludeDir = useCallback((dir: string) => {
    setExcludeDirs(prev => prev.filter(d => d !== dir));
  }, []);

  const handleCancelScan = useCallback(async () => {
    try {
      await invoke('cancel-scan');
    } catch (e) {
      toast.error('取消扫描失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [toast]);

  const isRunning = state === 'running';
  const phaseLabel = useMemo(() => {
    switch (progress.phase) {
      case 'enumerate': return '正在枚举文件';
      case 'prehash': return '正在预校验';
      case 'hash': return '正在计算哈希';
      case 'group': return '正在识别重复文件';
      default: return isRunning ? '扫描中' : '空闲';
    }
  }, [progress.phase, isRunning]);

  const percent = typeof progress.percent === 'number' && Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, progress.percent))
    : undefined;

  return (
    <div className="page-content">
      <PageHeader
        title={<>重复文件清理工具 {isDemoMode && <DemoBadge />}</>}
        description="扫描指定目录，按文件内容找出重复文件，让你安全预览、清理或暂时隔离。"
      />

      {isDemoMode && (
        <div style={{ marginBottom: 16 }}>
          <DemoBanner />
        </div>
      )}

      {/* ---------- 5.2 目录选择卡片 ---------- */}
      <Card
        title="选择扫描目录"
        icon={<FolderOpen size={15} strokeWidth={1.8} />}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleChooseDir}
            disabled={isRunning}
          >
            <FolderPlus size={13} strokeWidth={2} />
            添加目录
          </button>
        }
      >
        {directories.length === 0 ? (
          <div className="empty-state" style={{ padding: '20px 12px' }}>
            <FolderOpen size={28} strokeWidth={1.5} style={{ color: '#B8C0C9' }} />
            <div className="empty-state-desc">
              尚未添加任何目录。点击右上角「添加目录」选择要扫描的位置。
            </div>
          </div>
        ) : (
          <ul className="col" style={{ gap: 6, marginBottom: 12 }}>
            {directories.map(d => (
              <li
                key={d}
                className="row-between"
                style={{
                  padding: '6px 10px',
                  background: 'var(--bg)',
                  border: '1px solid var(--divider)',
                  borderRadius: 'var(--radius-sm)'
                }}
              >
                <span className="mono ellipsis" title={d} style={{ flex: 1, minWidth: 0 }}>{d}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`移除 ${d}`}
                  onClick={() => handleRemoveDir(d)}
                  disabled={isRunning}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ marginTop: directories.length === 0 ? 12 : 0 }}>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={handleStartScan}
            disabled={isRunning || directories.length === 0}
          >
            <Play size={14} strokeWidth={2.2} />
            {isRunning ? '扫描中…' : '开始扫描'}
          </button>
          {isRunning && (
            <button type="button" className="btn" onClick={handleCancelScan}>
              <X size={14} />
              取消扫描
            </button>
          )}
          {state === 'failed' && (
            <button
              type="button"
              className="btn"
              onClick={handleStartScan}
              disabled={directories.length === 0}
            >
              <RotateCcw size={13} />
              重试
            </button>
          )}
        </div>
        {error && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              background: '#FFEBE9',
              color: 'var(--danger)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid rgba(207,34,46,0.25)',
              fontSize: 'var(--fs-aux)'
            }}
          >
            {error}
          </div>
        )}
      </Card>

      {/* ---------- 5.3 扫描选项卡片 ---------- */}
      <Card title="扫描选项" icon={<Settings2 size={15} strokeWidth={1.8} />}>
        <div className="scan-options">
          {/* 校验级别 */}
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">校验级别</span>
              <span className="aux">识别重复文件时使用的哈希策略</span>
            </div>
            <select
              className="select"
              style={{ width: 200, flexShrink: 0 }}
              value={verify}
              disabled={isRunning}
              onChange={e => setVerify(e.target.value as AppSettings['verify'])}
              aria-label="校验级别"
            >
              <option value="Full">全量 SHA-256</option>
              <option value="Head">头部哈希</option>
              <option value="Name">仅文件名 + 大小</option>
            </select>
          </div>

          {/* 递归子目录 */}
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">递归子目录</span>
              <span className="aux">包含所选目录的全部子目录</span>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={recurse}
              disabled={isRunning}
              onChange={e => setRecurse(e.target.checked)}
              aria-label="递归子目录"
            />
          </div>

          {/* 检测硬链接 */}
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">检测硬链接</span>
              <span className="aux">同一文件的硬链接视为重复</span>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={detectLinks}
              disabled={isRunning}
              onChange={e => setDetectLinks(e.target.checked)}
              aria-label="检测硬链接"
            />
          </div>

          {/* 排除目录 */}
          <div>
            <div className="scan-option-label">
              <span className="strong">排除目录</span>
              <span className="aux">扫描时跳过这些目录（名称或绝对路径）</span>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                type="text"
                className="input"
                placeholder="如 node_modules 或 D:\\临时"
                value={excludeInput}
                disabled={isRunning}
                onChange={e => setExcludeInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddExcludeDir(); } }}
                aria-label="新增排除目录"
              />
              <button
                type="button"
                className="btn"
                onClick={handleAddExcludeDir}
                disabled={isRunning || excludeInput.trim().length === 0}
              >
                <Plus size={13} />
                添加
              </button>
            </div>
            {excludeDirs.length > 0 && (
              <ul className="exclude-list">
                {excludeDirs.map(d => (
                  <li key={d}>
                    <span className="mono ellipsis" title={d} style={{ flex: 1, minWidth: 0 }}>{d}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      aria-label={`移除 ${d}`}
                      onClick={() => handleRemoveExcludeDir(d)}
                      disabled={isRunning}
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      {/* ---------- 5.4 扫描进度卡片 ---------- */}
      <Card title="扫描进度" icon={<Zap size={15} strokeWidth={1.8} />}>
        <div className="row" style={{ gap: 24 }}>
          {/* 环形进度 */}
          <div className="ring-wrap" style={{ flexShrink: 0 }}>
            <svg width={96} height={96} viewBox="0 0 96 96" aria-hidden>
              <circle className="ring-bg" cx={48} cy={48} r={40} strokeWidth={8} fill="none" />
              {percent !== undefined && (
                <circle
                  className="ring-fg"
                  cx={48} cy={48} r={40} strokeWidth={8} fill="none"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 40}`}
                  strokeDashoffset={`${2 * Math.PI * 40 * (1 - percent / 100)}`}
                  transform="rotate(-90 48 48)"
                />
              )}
            </svg>
            <div className="ring-center-label">
              {percent !== undefined ? `${percent.toFixed(0)}%` : '—'}
            </div>
          </div>

          {/* 状态信息 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <span
                className={`status-dot status-${isRunning ? 'accent' : state === 'failed' ? 'danger' : state === 'cancelled' ? 'warn' : state === 'completed' ? 'success' : 'idle'}`}
              />
              <span className="strong">{phaseLabel}</span>
              {progress.sessionId !== undefined && (
                <span className="aux-sm mono">#{progress.sessionId}</span>
              )}
            </div>

            {/* 水平进度条 */}
            <div className="progress-bar" style={{ marginBottom: 8 }}>
              {percent !== undefined ? (
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              ) : isRunning ? (
                <div className="progress-indeterminate" />
              ) : null}
            </div>

            {/* 数据 */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '4px 16px',
                fontSize: 'var(--fs-aux)'
              }}
            >
              <div className="row">
                <span className="aux">已检查文件</span>
                <span className="num-strong">{formatCount(progress.scannedFiles ?? progress.current)}</span>
              </div>
              <div className="row">
                <span className="aux">已发现重复</span>
                <span className="num-strong">{formatCount(stats.duplicateFileCount)}</span>
              </div>
              <div className="row">
                <span className="aux">扫描耗时</span>
                <span className="num-strong">{formatDuration((progress.elapsedSec ?? 0) * 1000)}</span>
              </div>
              <div className="row">
                <span className="aux">错误</span>
                <span className="num-strong">{formatCount(progress.errorCount)}</span>
              </div>
            </div>

            {progress.currentFile && isRunning && (
              <div
                className="mono ellipsis aux-sm"
                style={{ marginTop: 8, color: 'var(--text2)' }}
                title={progress.currentFile}
              >
                {truncatePath(progress.currentFile, 80)}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ---------- 5.5 扫描结果摘要卡片 ---------- */}
      <Card title="扫描结果摘要" icon={<Search size={15} strokeWidth={1.8} />}>
        {loadingHistory ? (
          <div className="aux">加载中…</div>
        ) : stats.sessionId === null && !isDemoMode ? (
          <div className="aux">尚未完成任何扫描。添加目录并点击「开始扫描」以查看结果。</div>
        ) : (
          <>
            <div className="grid grid-4" style={{ marginBottom: 14 }}>
              <StatCard
                label="已扫描文件"
                value={formatCount(stats.scannedFileCount)}
              />
              <StatCard
                label="重复文件组"
                value={formatCount(stats.duplicateGroupCount)}
              />
              <StatCard
                label="可释放空间"
                value={formatBytes(stats.reclaimableBytes)}
              />
              <StatCard
                label="最近扫描"
                value={formatRelative(stats.lastScanAt)}
                hint={stats.lastScanAt ? new Date(stats.lastScanAt).toLocaleString('zh-CN') : undefined}
              />
            </div>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onNavigateToCleanup}
                disabled={stats.duplicateGroupCount === 0}
              >
                查看清理结果
              </button>
              {stats.duplicateGroupCount === 0 && state === 'completed' && (
                <span className="tag tag-success" style={{ marginLeft: 4 }}>未发现重复文件</span>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
