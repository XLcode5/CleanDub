import {
  Archive,
  CalendarClock,
  DatabaseZap,
  Eye,
  FileStack,
  History,
  RotateCcw,
  Shield,
  Trash2
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, isDemoMode } from '../bridge';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DemoBadge, DemoBanner } from '../components/DemoBadge';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { useToast } from '../components/Toast';
import type { QuarantineItem, ScanHistoryEntry } from '../types';
import { formatBytes, formatCount, formatDateTime, formatDuration, formatRelative, truncatePath } from '../utils';

export function ProfilePage() {
  const toast = useToast();
  const [history, setHistory] = useState<ScanHistoryEntry[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showQuarantine, setShowQuarantine] = useState(false);
  const [selectedQuarantineIds, setSelectedQuarantineIds] = useState<Set<number>>(new Set());
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: 'delete-history'; sessionId: number }
    | { kind: 'restore'; ids: number[] }
    | { kind: 'delete-quarantine'; ids: number[] }
    | { kind: 'reset-data'; scope: 'history' | 'quarantine' | 'all' }
    | null
  >(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [h, q] = await Promise.all([
        invoke('get-scan-history'),
        invoke('get-quarantine-items')
      ]);
      setHistory(h ?? []);
      setQuarantine(q ?? []);
    } catch (e) {
      toast.error('加载个人中心数据失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // ---------- 统计 ----------
  const completedHistory = useMemo(
    () => history.filter(h => h.status === 'completed' || h.status === 'cancelled'),
    [history]
  );
  const totalScans = completedHistory.length;
  const lastScanAt = completedHistory[0]?.completed_at ?? completedHistory[0]?.started_at ?? null;
  const totalScannedFiles = useMemo(
    () => completedHistory.reduce((acc, h) => acc + (h.scanned_file_count || 0), 0),
    [completedHistory]
  );

  const activeQuarantine = useMemo(
    () => quarantine.filter(q => q.status === 'quarantined'),
    [quarantine]
  );
  const quarantineSize = useMemo(
    () => activeQuarantine.reduce((acc, q) => acc + q.file_size, 0),
    [activeQuarantine]
  );
  const lastQuarantineAt = activeQuarantine[0]?.quarantined_at ?? null;

  // ---------- 操作 ----------
  const handleDeleteHistory = useCallback(async (sessionId: number) => {
    setBusy(true);
    try {
      await invoke('delete-scan-history', { sessionId });
      toast.success('历史记录已删除（不会影响隔离区数据）');
      await load();
    } catch (e) {
      toast.error('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }, [load, toast]);

  // ---------- 数据管理一键重置 ----------
  const handleResetData = useCallback(async (scope: 'history' | 'quarantine' | 'all') => {
    setBusy(true);
    try {
      await invoke('reset-app-data', { scope });
      const label = scope === 'history' ? '扫描历史已清空'
        : scope === 'quarantine' ? '隔离区记录已清空（磁盘上的隔离文件不受影响）'
        : '全部数据已重置';
      toast.success(label);
      await load();
    } catch (e) {
      toast.error('重置失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }, [load, toast]);

  const handleRestore = useCallback(async (ids: number[]) => {
    setBusy(true);
    try {
      const r = await invoke('restore-quarantined-files', { quarantineIds: ids });
      toast.success(`已恢复 ${r.ok} 个文件${r.failed > 0 ? `，${r.failed} 个失败` : ''}`);
      setSelectedQuarantineIds(new Set());
      await load();
    } catch (e) {
      toast.error('恢复失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }, [load, toast]);

  const handlePermanentDelete = useCallback(async (ids: number[]) => {
    setBusy(true);
    try {
      const r = await invoke('permanently-delete-files', { quarantineIds: ids });
      toast.success(`已永久删除 ${r.ok} 个文件`);
      setSelectedQuarantineIds(new Set());
      await load();
    } catch (e) {
      toast.error('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }, [load, toast]);

  const toggleQuarantine = useCallback((id: number) => {
    setSelectedQuarantineIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // v1.0.2：隔离区全选/全不选（三态联动批量按钮）
  const activeQuarantineIds = useMemo(
    () => new Set(activeQuarantine.map(q => q.id)),
    [activeQuarantine]
  );
  const allQuarantineSelected = activeQuarantine.length > 0
    && activeQuarantine.every(q => selectedQuarantineIds.has(q.id));
  const toggleAllQuarantine = useCallback(() => {
    setSelectedQuarantineIds(
      allQuarantineSelected ? new Set() : new Set(activeQuarantineIds)
    );
  }, [allQuarantineSelected, activeQuarantineIds]);

  const statusLabel = (s: ScanHistoryEntry['status']) => {
    switch (s) {
      case 'completed': return <span className="tag tag-success">已完成</span>;
      case 'cancelled': return <span className="tag tag-warn">已取消</span>;
      case 'failed': return <span className="tag tag-danger">失败</span>;
      case 'running': return <span className="tag tag-accent">进行中</span>;
    }
  };

  return (
    <div className="page-content">
      <PageHeader
        title={<>个人中心 {isDemoMode && <DemoBadge />}</>}
        description="管理扫描历史与隔离区文件。"
      />

      {isDemoMode && (
        <div style={{ marginBottom: 16 }}>
          <DemoBanner />
        </div>
      )}

      {/* ---------- 7.2 顶部统计卡片 ---------- */}
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Card title="扫描历史" icon={<History size={15} strokeWidth={1.8} />}>
          <div className="grid grid-3">
            <StatCard
              label="历史扫描次数"
              value={formatCount(totalScans)}
              icon={<FileStack size={12} strokeWidth={1.8} />}
            />
            <StatCard
              label="最近一次扫描"
              value={formatRelative(lastScanAt)}
              icon={<CalendarClock size={12} strokeWidth={1.8} />}
            />
            <StatCard
              label="累计扫描文件"
              value={formatCount(totalScannedFiles)}
              icon={<Eye size={12} strokeWidth={1.8} />}
            />
          </div>
        </Card>

        <Card title="隔离区文件" icon={<Shield size={15} strokeWidth={1.8} />}>
          <div className="grid grid-3">
            <StatCard
              label="当前隔离文件"
              value={formatCount(activeQuarantine.length)}
              icon={<Archive size={12} strokeWidth={1.8} />}
            />
            <StatCard
              label="隔离总大小"
              value={formatBytes(quarantineSize)}
            />
            <StatCard
              label="最近一次隔离"
              value={formatRelative(lastQuarantineAt)}
            />
          </div>
        </Card>
      </div>

      {/* ---------- 7.3 扫描历史表格 ---------- */}
      <Card title="扫描历史" icon={<History size={15} strokeWidth={1.8} />}>
        {loading ? (
          <div className="aux">加载中…</div>
        ) : history.length === 0 ? (
          <EmptyState icon={History} title="暂无扫描历史" description="完成一次扫描后，这里会显示历史记录。" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>扫描目录</th>
                  <th>文件数</th>
                  <th>重复组</th>
                  <th>耗时</th>
                  <th>状态</th>
                  <th style={{ width: 140 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id}>
                    <td>
                      <div className="strong">{formatDateTime(h.started_at)}</div>
                      <div className="aux-sm">{formatRelative(h.started_at)}</div>
                    </td>
                    <td className="aux" style={{ maxWidth: 240 }}>
                      {h.roots.length === 0 ? '—' : (
                        <div className="col" style={{ gap: 2 }}>
                          {h.roots.slice(0, 2).map(r => (
                            <span key={r} className="mono ellipsis" title={r} style={{ display: 'block' }}>
                              {truncatePath(r, 36)}
                            </span>
                          ))}
                          {h.roots.length > 2 && (
                            <span className="aux-sm">+{h.roots.length - 2} 个目录</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="num-strong">{formatCount(h.scanned_file_count)}</td>
                    <td className="num-strong">{formatCount(h.duplicate_group_count)}</td>
                    <td className="num-strong">{formatDuration(h.duration_ms)}</td>
                    <td>{statusLabel(h.status)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setPendingConfirm({ kind: 'delete-history', sessionId: h.id })}
                        title="删除该历史记录（不影响隔离区）"
                      >
                        <Trash2 size={12} />
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---------- 7.4 隔离区管理卡片 ---------- */}
      <Card
        title="隔离区管理"
        icon={<Shield size={15} strokeWidth={1.8} />}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowQuarantine(v => !v)}
          >
            {showQuarantine ? '收起' : '查看隔离区'}
          </button>
        }
      >
        <p className="aux" style={{ marginBottom: 10 }}>
          隔离区中的文件不会参与常规扫描，可在这里还原到原始位置或永久删除。
        </p>
        <div className="row" style={{ gap: 24 }}>
          <div>
            <div className="aux-sm">当前文件数</div>
            <div className="num-strong" style={{ fontSize: 18 }}>{formatCount(activeQuarantine.length)}</div>
          </div>
          <div>
            <div className="aux-sm">总大小</div>
            <div className="num-strong" style={{ fontSize: 18 }}>{formatBytes(quarantineSize)}</div>
          </div>
          <div>
            <div className="aux-sm">最近一次隔离</div>
            <div className="num-strong" style={{ fontSize: 18 }}>{formatRelative(lastQuarantineAt)}</div>
          </div>
        </div>

        {/* ---------- 7.5 隔离区详情 ---------- */}
        {showQuarantine && (
          <div style={{ marginTop: 14 }}>
            <hr className="divider" style={{ marginBottom: 12 }} />
            {activeQuarantine.length === 0 ? (
              <EmptyState icon={Archive} title="隔离区为空" description="暂无被隔离的文件。" />
            ) : (
              <>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="aux">
                    已选 {selectedQuarantineIds.size}/{activeQuarantine.length} 项
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: 8 }}
                      onClick={toggleAllQuarantine}
                      disabled={activeQuarantine.length === 0 || busy}
                    >
                      {allQuarantineSelected ? '取消全选' : '全选'}
                    </button>
                  </span>
                  <div style={{ marginLeft: 'auto' }} className="row">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={selectedQuarantineIds.size === 0 || busy}
                      onClick={() => setPendingConfirm({ kind: 'restore', ids: Array.from(selectedQuarantineIds) })}
                    >
                      <RotateCcw size={12} />
                      批量恢复
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={selectedQuarantineIds.size === 0 || busy}
                      onClick={() => setPendingConfirm({ kind: 'delete-quarantine', ids: Array.from(selectedQuarantineIds) })}
                    >
                      <Trash2 size={12} />
                      批量永久删除
                    </button>
                  </div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>
                          <input
                            type="checkbox"
                            checked={allQuarantineSelected}
                            ref={el => {
                              if (el) el.indeterminate = selectedQuarantineIds.size > 0 && !allQuarantineSelected;
                            }}
                            onChange={toggleAllQuarantine}
                            aria-label="全选隔离区文件"
                            disabled={busy || activeQuarantine.length === 0}
                          />
                        </th>
                        <th>文件名</th>
                        <th>原始路径</th>
                        <th>隔离时间</th>
                        <th>大小</th>
                        <th>SHA-256</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeQuarantine.map(q => (
                        <tr key={q.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedQuarantineIds.has(q.id)}
                              onChange={() => toggleQuarantine(q.id)}
                              aria-label={`选择 ${q.file_name}`}
                            />
                          </td>
                          <td className="strong ellipsis" style={{ maxWidth: 180 }}>{q.file_name}</td>
                          <td className="mono aux ellipsis" style={{ maxWidth: 0 }} title={q.original_path}>
                            {truncatePath(q.original_path, 50)}
                          </td>
                          <td className="aux">{formatDateTime(q.quarantined_at)}</td>
                          <td className="num-strong">{formatBytes(q.file_size)}</td>
                          <td className="mono aux ellipsis" style={{ maxWidth: 140 }} title={q.sha256 ?? ''}>
                            {q.sha256 ? `${q.sha256.slice(0, 12)}…` : '—'}
                          </td>
                          <td><span className="tag tag-accent">已隔离</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </Card>

      {/* ---------- 7.6 数据管理 ---------- */}
      <Card title="数据管理" icon={<DatabaseZap size={15} strokeWidth={1.8} />}>
        <p className="aux" style={{ marginBottom: 12 }}>
          清空应用内的记录数据。设置（扫描选项/隔离区位置）不受影响；磁盘上的原始文件和隔离区文件不会被删除。
        </p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || totalScans === 0}
            onClick={() => setPendingConfirm({ kind: 'reset-data', scope: 'history' })}
          >
            <History size={13} />
            清空扫描历史{totalScans > 0 ? `（${formatCount(totalScans)} 次）` : ''}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || quarantine.length === 0}
            onClick={() => setPendingConfirm({ kind: 'reset-data', scope: 'quarantine' })}
          >
            <Archive size={13} />
            清空隔离区记录{quarantine.length > 0 ? `（${formatCount(quarantine.length)} 条）` : ''}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy || (totalScans === 0 && quarantine.length === 0)}
            onClick={() => setPendingConfirm({ kind: 'reset-data', scope: 'all' })}
          >
            <DatabaseZap size={13} />
            全部重置
          </button>
        </div>
      </Card>

      {/* 删除历史确认 */}
      <ConfirmDialog
        open={pendingConfirm?.kind === 'delete-history'}
        tone="warn"
        title="删除扫描历史记录"
        confirmLabel="删除"
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && pendingConfirm.kind === 'delete-history' && handleDeleteHistory(pendingConfirm.sessionId)}
      >
        <p>此操作仅删除历史记录条目，不会影响隔离区文件或原始文件。</p>
      </ConfirmDialog>

      {/* 恢复确认 */}
      <ConfirmDialog
        open={pendingConfirm?.kind === 'restore'}
        tone="info"
        title="恢复隔离区文件"
        confirmLabel="恢复"
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && pendingConfirm.kind === 'restore' && handleRestore(pendingConfirm.ids)}
      >
        <p>
          将把 <strong>{pendingConfirm?.kind === 'restore' ? pendingConfirm.ids.length : 0}</strong> 个文件恢复到原始位置。
          如果原始路径已存在同名文件，将提示冲突。
        </p>
      </ConfirmDialog>

      {/* 永久删除确认 */}
      <ConfirmDialog
        open={pendingConfirm?.kind === 'delete-quarantine'}
        tone="danger"
        title="永久删除隔离区文件"
        confirmLabel="永久删除"
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && pendingConfirm.kind === 'delete-quarantine' && handlePermanentDelete(pendingConfirm.ids)}
      >
        <p style={{ color: 'var(--danger)', fontWeight: 500 }}>
          永久删除后无法通过应用恢复。确定要删除 <strong>{pendingConfirm?.kind === 'delete-quarantine' ? pendingConfirm.ids.length : 0}</strong> 个隔离文件吗？
        </p>
      </ConfirmDialog>

      {/* 数据管理重置确认 */}
      <ConfirmDialog
        open={pendingConfirm?.kind === 'reset-data'}
        tone={pendingConfirm?.kind === 'reset-data' && pendingConfirm.scope === 'all' ? 'danger' : 'warn'}
        title={
          pendingConfirm?.kind === 'reset-data' && pendingConfirm.scope === 'history' ? '清空扫描历史'
          : pendingConfirm?.kind === 'reset-data' && pendingConfirm.scope === 'quarantine' ? '清空隔离区记录'
          : '全部重置'
        }
        confirmLabel="确认重置"
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && pendingConfirm.kind === 'reset-data' && handleResetData(pendingConfirm.scope)}
      >
        {pendingConfirm?.kind === 'reset-data' && pendingConfirm.scope === 'history' && (
          <p>将删除全部 <strong>{formatCount(totalScans)}</strong> 次扫描历史及其文件分组记录。不影响隔离区数据。</p>
        )}
        {pendingConfirm?.kind === 'reset-data' && pendingConfirm.scope === 'quarantine' && (
          <p>将清空 <strong>{formatCount(quarantine.length)}</strong> 条隔离记录。<strong>磁盘上的隔离文件不会被删除</strong>，但应用将不再显示它们（需手动到隔离区目录处理）。</p>
        )}
        {pendingConfirm?.kind === 'reset-data' && pendingConfirm.scope === 'all' && (
          <p style={{ color: 'var(--danger)' }}>
            将清空全部扫描历史与隔离区记录，应用回到全新状态。设置不受影响；
            磁盘上的原始文件和隔离区文件不会被删除。此操作不可撤销。
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
