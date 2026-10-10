import {
  Archive,
  ArrowDownWideNarrow,
  CheckCircle2,
  File,
  FileAudio,
  FileText,
  Film,
  Image as ImageIcon,
  LayoutGrid,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  WandSparkles
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
import type { DuplicateFileItem, DuplicateGroup } from '../types';
import {
  baseName,
  categoryLabel,
  categoryOf,
  extOf,
  formatBytes,
  formatCount,
  formatDateTime,
  formatRelative,
  truncatePath,
  type FileCategory
} from '../utils';

type SortKey = 'size' | 'count' | 'type' | 'path';
type FilterKey = FileCategory | 'all';

/** 智能保留策略 —— 与引擎 pickKeeper 一致（v1.0.1 扩展 ShortestName/LongestName） */
type RetentionStrategy = 'Newest' | 'ShortestName' | 'LongestName' | 'Original' | 'Cleanest';
const RETENTION_OPTIONS: Array<{ value: RetentionStrategy; label: string; desc: string }> = [
  { value: 'Newest', label: '修改时间最新', desc: '每组保留 mtime 最新的文件' },
  { value: 'ShortestName', label: '文件名最短', desc: '同长时取修改时间最新' },
  { value: 'LongestName', label: '文件名最长', desc: '同长时取修改时间最新' },
  { value: 'Original', label: '原件优先', desc: '无 (1) 后缀的原件；都带后缀则取最新' },
  { value: 'Cleanest', label: '名字最干净', desc: '(N) 后缀最少 → 最新 → 路径最短' }
];

interface CleanupPageProps {
  onRescanRequest: () => void;
}

const CATEGORY_ORDER: FilterKey[] = ['all', 'image', 'video', 'document', 'archive', 'audio', 'other'];

const CATEGORY_ICONS: Record<FilterKey, typeof ImageIcon> = {
  all: LayoutGrid,
  image: ImageIcon,
  video: Film,
  document: FileText,
  archive: Archive,
  audio: FileAudio,
  other: File
};

const CATEGORY_LABEL: Record<FilterKey, string> = {
  all: '全部分组',
  image: '图片',
  video: '视频',
  document: '文档',
  archive: '压缩包',
  audio: '音频',
  other: '其他'
};

function fileDisplayName(f: DuplicateFileItem): string {
  return f.file_name ?? f.name ?? baseName(f.canonical_path ?? f.path ?? '');
}
function filePath(f: DuplicateFileItem): string {
  return f.canonical_path ?? f.path ?? '';
}
function fileSize(f: DuplicateFileItem): number {
  return f.file_size ?? f.size ?? 0;
}
function fileMtime(f: DuplicateFileItem): string | undefined {
  const v = f.modified_at ?? f.modifiedAt;
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return new Date(v).toISOString();
  return v;
}

function groupCategory(g: DuplicateGroup): FileCategory {
  const first = g.files[0];
  return categoryOf(fileDisplayName(first));
}

export function CleanupPage({ onRescanRequest }: CleanupPageProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);

  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('size');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: 'quarantine'; ids: number[] }
    | { kind: 'delete'; ids: number[] }
    | { kind: 'retention'; strategy: RetentionStrategy }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await invoke('get-duplicate-groups');
      setGroups(r.groups ?? []);
      setSessionId(r.sessionId ?? null);
    } catch (e) {
      toast.error('加载重复文件分组失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadHistoryTime = useCallback(async () => {
    try {
      const history = await invoke('get-scan-history');
      const latest = history.find(h => h.status === 'completed' || h.status === 'cancelled');
      if (latest) setLastScanAt(latest.completed_at ?? latest.started_at);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { load(); loadHistoryTime(); }, [load, loadHistoryTime]);

  // ---------- 统计 ----------
  const totalGroups = groups.length;
  const totalReclaimable = useMemo(() => {
    let sum = 0;
    for (const g of groups) {
      const size = g.file_size ?? g.fileSize ?? 0;
      sum += size * Math.max(0, g.files.length - 1);
    }
    return sum;
  }, [groups]);

  const categoryCounts = useMemo(() => {
    const m = new Map<FilterKey, number>();
    for (const k of CATEGORY_ORDER) m.set(k, 0);
    for (const g of groups) {
      const c = groupCategory(g);
      m.set(c, (m.get(c) ?? 0) + 1);
      m.set('all', (m.get('all') ?? 0) + 1);
    }
    return m;
  }, [groups]);

  // ---------- 过滤/排序 ----------
  const visibleGroups = useMemo(() => {
    let list = groups;
    if (filter !== 'all') list = list.filter(g => groupCategory(g) === filter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(g =>
        g.files.some(f =>
          fileDisplayName(f).toLowerCase().includes(q) ||
          filePath(f).toLowerCase().includes(q) ||
          (g.sha256 ?? '').toLowerCase().startsWith(q)
        )
      );
    }
    const sorted = [...list].sort((a, b) => {
      if (sortKey === 'size') {
        const sa = (a.file_size ?? a.fileSize ?? 0) * a.files.length;
        const sb = (b.file_size ?? b.fileSize ?? 0) * b.files.length;
        return sb - sa;
      }
      if (sortKey === 'count') return b.files.length - a.files.length;
      if (sortKey === 'type') return groupCategory(a).localeCompare(groupCategory(b));
      // path
      const pa = filePath(a.files[0] ?? {});
      const pb = filePath(b.files[0] ?? {});
      return pa.localeCompare(pb);
    });
    return sorted;
  }, [groups, filter, search, sortKey]);

  // ---------- 选择 ----------
  const allVisibleFileIds = useMemo(() => {
    const ids = new Set<number>();
    for (const g of visibleGroups) {
      for (const f of g.files) {
        if (f.id !== g.retained_file_id && f.id !== undefined) ids.add(f.id);
      }
    }
    return ids;
  }, [visibleGroups]);

  const toggleFile = useCallback((fileId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId); else next.add(fileId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(allVisibleFileIds));
  }, [allVisibleFileIds]);

  const clearAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // ---------- 保留 ----------
  const handleSetRetained = useCallback(async (groupId: number, fileId: number) => {
    try {
      await invoke('set-retained-file', { groupId, fileId });
      setGroups(prev =>
        prev.map(g => g.id === groupId ? { ...g, retained_file_id: fileId } : g)
      );
      toast.success('已标记为保留文件');
    } catch (e) {
      toast.error('设置保留文件失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [toast]);

  // ---------- 智能保留（v1.0.1）：按策略批量标记 + 反向全选 ----------
  // 当前视图内未标记保留的组数（策略将作用于这些组）
  const unmarkedVisibleGroups = useMemo(
    () => visibleGroups.filter(g => !g.retained_file_id),
    [visibleGroups]
  );

  const confirmRetention = useCallback(async (strategy: RetentionStrategy) => {
    setBusy(true);
    try {
      const groupIds = unmarkedVisibleGroups.map(g => g.id);
      const r = await invoke('apply-retention-strategy', {
        sessionId: sessionId ?? undefined,
        strategy,
        groupIds
      });
      toast.success(
        `已为 ${r.groupsUpdated} 组标记保留` +
        (r.skipped > 0 ? `（跳过已标记 ${r.skipped} 组）` : '')
      );
      await load();
    } catch (e) {
      toast.error('应用保留策略失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }, [unmarkedVisibleGroups, sessionId, load, toast]);

  // 反向全选：勾选所有非保留、未勾选的可见文件
  const selectInverse = useCallback(() => {
    setSelectedIds(new Set(allVisibleFileIds));
  }, [allVisibleFileIds]);

  // ---------- 隔离/删除 ----------
  const confirmQuarantine = useCallback(async (ids: number[]) => {
    setBusy(true);
    try {
      const r = await invoke('quarantine-files', { fileIds: ids });
      toast.success(`已隔离 ${r.ok} 个文件${r.failed > 0 ? `，${r.failed} 个失败` : ''}`);
      setSelectedIds(new Set());
      await load();
    } catch (e) {
      toast.error('隔离失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }, [load, toast]);

  const confirmPermanentDelete = useCallback(async (ids: number[]) => {
    setBusy(true);
    try {
      // v1.0.2：清理页直删通道 —— 传 fileIds（scanned_files.id），引擎直接删磁盘文件
      const r = await invoke('permanently-delete-files', { fileIds: ids });
      toast.success(`已永久删除 ${r.ok} 个文件${r.failed > 0 ? `，${r.failed} 个失败` : ''}${r.skipped ? `（${r.skipped} 个保留文件已跳过）` : ''}`);
      setSelectedIds(new Set());
      await load();
    } catch (e) {
      toast.error('永久删除失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }, [load, toast]);

  const selectedCount = selectedIds.size;
  const selectedBytes = useMemo(() => {
    let s = 0;
    for (const g of groups) {
      for (const f of g.files) {
        if (f.id !== undefined && selectedIds.has(f.id)) s += fileSize(f);
      }
    }
    return s;
  }, [groups, selectedIds]);

  // 需要展示的待处理文件清单（确认对话框中显示前几条）
  const selectedPreview = useMemo(() => {
    const arr: { id: number; name: string; path: string; size: number }[] = [];
    for (const g of groups) {
      for (const f of g.files) {
        if (f.id !== undefined && selectedIds.has(f.id)) {
          arr.push({ id: f.id, name: fileDisplayName(f), path: filePath(f), size: fileSize(f) });
        }
      }
    }
    arr.sort((a, b) => b.size - a.size);
    return arr;
  }, [groups, selectedIds]);

  return (
    <div className="page-content">
      <PageHeader
        title={<>重复文件清理 {isDemoMode && <DemoBadge />}{sessionId !== null && <span className="tag" style={{ marginLeft: 4 }} title="当前展示的是此扫描会话的分组结果">会话 #{sessionId}</span>}</>}
        description="查看重复文件分组，选择保留、清理或隔离。"
        extra={
          <button
            type="button"
            className="btn"
            onClick={onRescanRequest}
            disabled={busy}
            title="返回首页重新扫描"
          >
            <RotateCcw size={13} />
            重新扫描
          </button>
        }
      />

      {isDemoMode && (
        <div style={{ marginBottom: 16 }}>
          <DemoBanner />
        </div>
      )}

      {/* 顶部统计卡片 */}
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <StatCard label="重复文件组" value={formatCount(totalGroups)} />
        <StatCard label="可释放空间" value={formatBytes(totalReclaimable)} />
        <StatCard label="最近一次扫描" value={formatRelative(lastScanAt)} hint={lastScanAt ? formatDateTime(lastScanAt) : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 'var(--gap-card)', alignItems: 'start' }}>
        {/* ---------- 6.2 左侧文件类型筛选栏 ---------- */}
        <Card title="文件类型" icon={<LayoutGrid size={14} strokeWidth={1.8} />}>
          <ul className="col" style={{ gap: 2 }}>
            {CATEGORY_ORDER.map(key => {
              const Icon = CATEGORY_ICONS[key];
              const count = categoryCounts.get(key) ?? 0;
              const active = filter === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={`sidebar-item${active ? ' active' : ''}`}
                    onClick={() => setFilter(key)}
                    style={{ width: '100%', justifyContent: 'space-between' }}
                  >
                    <span className="row" style={{ gap: 6 }}>
                      <Icon size={14} strokeWidth={1.8} />
                      <span>{CATEGORY_LABEL[key]}</span>
                    </span>
                    <span className="aux-sm num-strong">{formatCount(count)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* ---------- 6.3 分组列表 ---------- */}
        <div>
          {/* 工具栏 */}
          <Card flush>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--divider)' }} className="row">
              <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
                <Search
                  size={13}
                  strokeWidth={1.8}
                  style={{
                    position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                    color: 'var(--text2)', pointerEvents: 'none'
                  }}
                />
                <input
                  type="text"
                  className="input"
                  placeholder="搜索文件名、路径或哈希前缀…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ paddingLeft: 28 }}
                />
              </div>
              <div className="row" style={{ marginLeft: 'auto' }}>
                {/* 智能保留（v1.0.1）：两步确认制 —— 第一步选策略标记保留 */}
                <select
                  className="select"
                  style={{ width: 150, height: 28 }}
                  defaultValue=""
                  disabled={busy || unmarkedVisibleGroups.length === 0}
                  onChange={e => {
                    const v = e.target.value as RetentionStrategy;
                    if (v) setPendingConfirm({ kind: 'retention', strategy: v });
                    e.target.value = '';
                  }}
                  aria-label="智能保留策略"
                  title={unmarkedVisibleGroups.length === 0 ? '没有可标记的组' : `将为当前可见的 ${unmarkedVisibleGroups.length} 组应用保留策略`}
                >
                  <option value="">🪄 智能保留…</option>
                  {RETENTION_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={selectInverse}
                  disabled={busy || allVisibleFileIds.size === 0}
                  title="勾选所有非保留的可见文件（保留文件自动跳过）"
                >
                  <WandSparkles size={12} />
                  反选其余
                </button>
                <span className="aux-sm">排序</span>
                <select
                  className="select"
                  style={{ width: 140, height: 28 }}
                  value={sortKey}
                  onChange={e => setSortKey(e.target.value as SortKey)}
                >
                  <option value="size">按文件大小</option>
                  <option value="count">按重复数量</option>
                  <option value="type">按文件类型</option>
                  <option value="path">按扫描路径</option>
                </select>
                <button type="button" className="btn btn-sm" onClick={selectAll} disabled={allVisibleFileIds.size === 0}>
                  全选
                </button>
                <button type="button" className="btn btn-sm" onClick={clearAll} disabled={selectedCount === 0}>
                  清空
                </button>
              </div>
            </div>
          </Card>

          {/* 列表 */}
          {loading ? (
            <Card><div className="aux">加载中…</div></Card>
          ) : visibleGroups.length === 0 ? (
            <Card>
              <EmptyState
                icon={CheckCircle2}
                title="未发现符合条件的重复文件"
                description={filter === 'all' && !search ? '当前没有可清理的重复文件。' : '请调整筛选条件或重新扫描。'}
              />
            </Card>
          ) : (
            <div className="col" style={{ marginTop: 12, gap: 10 }}>
              {visibleGroups.map(g => {
                const cat = groupCategory(g);
                const CatIcon = CATEGORY_ICONS[cat];
                const sizePer = g.file_size ?? g.fileSize ?? 0;
                const isExpanded = expandedGroup === g.id;
                return (
                  <Card key={g.id} flush>
                    {/* 组头 */}
                    <button
                      type="button"
                      onClick={() => setExpandedGroup(isExpanded ? null : g.id)}
                      style={{
                        width: '100%', padding: '10px 14px', background: 'transparent', border: 'none',
                        display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                        textAlign: 'left', borderBottom: isExpanded ? '1px solid var(--divider)' : 'none'
                      }}
                    >
                      <CatIcon size={18} strokeWidth={1.8} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <span className="strong ellipsis" style={{ fontSize: 'var(--fs-body-lg)' }}>
                            {fileDisplayName(g.files[0] ?? {})}
                          </span>
                          <span className="tag tag-accent">{g.files.length} 个副本</span>
                          <span className="tag">{categoryLabel(cat)}</span>
                          {g.retained_file_id !== null && g.retained_file_id !== undefined && (
                            <span className="tag tag-success">
                              <ShieldCheck size={10} />已设保留
                            </span>
                          )}
                        </div>
                        <div className="aux-sm mono ellipsis" style={{ marginTop: 2 }}>
                          {formatBytes(sizePer)} · {extOf(fileDisplayName(g.files[0] ?? {})) || '—'} · SHA-256 {g.sha256?.slice(0, 16)}…
                        </div>
                      </div>
                      <ArrowDownWideNarrow
                        size={14}
                        style={{
                          color: 'var(--text2)', flexShrink: 0,
                          transform: isExpanded ? 'rotate(180deg)' : 'none',
                          transition: 'transform var(--trans)'
                        }}
                      />
                    </button>

                    {/* 文件列表 */}
                    {isExpanded && (
                      <div style={{ padding: '4px 0' }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th style={{ width: 32 }}></th>
                              <th>文件名</th>
                              <th style={{ width: 120 }}>大小</th>
                              <th style={{ width: 140 }}>修改时间</th>
                              <th>路径</th>
                              <th style={{ width: 140 }}>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.files.map(f => {
                              const id = f.id ?? -1;
                              const isRetained = g.retained_file_id === id;
                              const isChecked = selectedIds.has(id);
                              return (
                                <tr key={id}>
                                  <td>
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      disabled={isRetained}
                                      onChange={() => toggleFile(id)}
                                      aria-label={`选择 ${fileDisplayName(f)}`}
                                    />
                                  </td>
                                  <td>
                                    <div className="row" style={{ gap: 6 }}>
                                      <span className="strong ellipsis" style={{ maxWidth: 220 }}>{fileDisplayName(f)}</span>
                                      {isRetained && (
                                        <span className="tag tag-success">
                                          <ShieldCheck size={10} />保留
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="num-strong">{formatBytes(fileSize(f))}</td>
                                  <td className="aux">{formatDateTime(fileMtime(f))}</td>
                                  <td className="mono aux ellipsis" style={{ maxWidth: 0 }} title={filePath(f)}>
                                    {truncatePath(filePath(f), 60)}
                                  </td>
                                  <td>
                                    {!isRetained && (
                                      <button
                                        type="button"
                                        className="btn btn-sm btn-ghost"
                                        onClick={() => handleSetRetained(g.id, id)}
                                        title="将此文件标记为保留，不会被清理或隔离"
                                      >
                                        <ShieldCheck size={12} />
                                        保留此文件
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}

          {/* 操作栏 */}
          {selectedCount > 0 && (
            <div
              style={{
                position: 'sticky', bottom: 16, marginTop: 16,
                background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '10px 14px',
                boxShadow: 'var(--shadow-pop)', display: 'flex', alignItems: 'center', gap: 12
              }}
            >
              <div className="row" style={{ gap: 6 }}>
                <CheckCircle2 size={15} strokeWidth={2} style={{ color: 'var(--accent)' }} />
                <span className="strong">已选 {selectedCount} 个文件</span>
                <span className="aux">约 {formatBytes(selectedBytes)}</span>
              </div>
              <div style={{ marginLeft: 'auto' }} className="row">
                <button type="button" className="btn" onClick={clearAll} disabled={busy}>取消选择</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setPendingConfirm({ kind: 'quarantine', ids: Array.from(selectedIds) })}
                  disabled={busy}
                >
                  <ShieldCheck size={13} />
                  隔离所选
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setPendingConfirm({ kind: 'delete', ids: Array.from(selectedIds) })}
                  disabled={busy}
                >
                  <Trash2 size={13} />
                  永久删除
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 隔离确认 */}
      <ConfirmDialog
        open={pendingConfirm?.kind === 'quarantine'}
        tone="info"
        title="确认隔离选中文件"
        confirmLabel="隔离"
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && pendingConfirm.kind === 'quarantine' && confirmQuarantine(pendingConfirm.ids)}
      >
        <p style={{ marginBottom: 10 }}>
          将把 <strong>{pendingConfirm?.kind === 'quarantine' ? pendingConfirm.ids.length : 0}</strong> 个文件移动到隔离区（约 {formatBytes(selectedBytes)}）。
          隔离区文件不参与常规扫描，可随时恢复。
        </p>
        <ul style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--divider)', borderRadius: 4, padding: 8 }}>
          {selectedPreview.slice(0, 8).map(p => (
            <li key={p.id} className="mono aux ellipsis" style={{ padding: '2px 0' }} title={p.path}>
              {truncatePath(p.path, 70)}
            </li>
          ))}
          {selectedPreview.length > 8 && (
            <li className="aux" style={{ padding: '4px 0' }}>… 以及另外 {selectedPreview.length - 8} 个文件</li>
          )}
        </ul>
      </ConfirmDialog>

      {/* 永久删除确认（更严格） */}
      <ConfirmDialog
        open={pendingConfirm?.kind === 'delete'}
        tone="danger"
        title="永久删除（不可恢复）"
        confirmLabel="永久删除"
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && pendingConfirm.kind === 'delete' && confirmPermanentDelete(pendingConfirm.ids)}
      >
        <p style={{ marginBottom: 10, color: 'var(--danger)', fontWeight: 500 }}>
          将从磁盘<strong>直接永久删除</strong>（不经隔离区）{pendingConfirm?.kind === 'delete' ? pendingConfirm.ids.length : 0} 个文件。
          此操作无法通过应用恢复，保留文件自动受保护。
        </p>
        <p className="aux" style={{ marginBottom: 10 }}>
          建议优先使用隔离操作，永久删除仅在确认数据已无用时使用。
        </p>
        <ul style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid rgba(207,34,46,0.25)', background: '#FFEBE9', borderRadius: 4, padding: 8 }}>
          {selectedPreview.slice(0, 8).map(p => (
            <li key={p.id} className="mono aux ellipsis" style={{ padding: '2px 0' }} title={p.path}>
              {truncatePath(p.path, 70)}
            </li>
          ))}
          {selectedPreview.length > 8 && (
            <li className="aux" style={{ padding: '4px 0' }}>… 以及另外 {selectedPreview.length - 8} 个文件</li>
          )}
        </ul>
      </ConfirmDialog>

      {/* 智能保留策略确认（v1.0.1 第一步：仅标记，不执行清理） */}
      <ConfirmDialog
        open={pendingConfirm?.kind === 'retention'}
        tone="info"
        title="应用智能保留策略"
        confirmLabel="标记保留"
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && pendingConfirm.kind === 'retention' && confirmRetention(pendingConfirm.strategy)}
      >
        {pendingConfirm?.kind === 'retention' && (
          <>
            <p style={{ marginBottom: 8 }}>
              将为当前可见的 <strong>{unmarkedVisibleGroups.length}</strong> 组重复文件，
              按「<strong>{RETENTION_OPTIONS.find(o => o.value === pendingConfirm.strategy)?.label}</strong>」策略标记每组保留文件。
              已手工标记的组自动跳过。
            </p>
            <p className="aux">
              {RETENTION_OPTIONS.find(o => o.value === pendingConfirm.strategy)?.desc}。
              此步骤只做标记，不删除任何文件；标记后请用「反选其余」勾选待处理文件，再执行隔离或删除。
            </p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
