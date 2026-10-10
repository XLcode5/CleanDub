/**
 * 设置页 —— 规格 07-profile-page.md §7.6 设置入口的集中实现。
 * 分组：扫描 / 清理安全 / 隔离区 / 关于与更新。
 * 所有选项走 get-app-settings / update-app-settings 持久化，
 * 与首页「扫描选项」卡片共享同一设置源（改这里，首页同步生效）。
 */
import { FolderOpen, Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isDemoMode } from '../bridge';
import { Card } from '../components/Card';
import { DemoBadge } from '../components/DemoBadge';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import type { AppSettings, UpdateCheckResult } from '../types';
import { formatDateTime } from '../utils';

const VERIFY_OPTIONS: Array<{ value: AppSettings['verify']; label: string; desc: string }> = [
  { value: 'Full', label: '全量 SHA-256（最准确）', desc: '读取整个文件计算哈希，不会误判' },
  { value: 'Head', label: '头部哈希（更快）', desc: '只读文件头部，速度更快但极小概率误判' },
  { value: 'Name', label: '仅文件名 + 大小（最快）', desc: '不读内容，仅按名称与大小分组，需人工确认' },
];

export function SettingsPage() {
  const toast = useToast();
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);

  // ---------- 设置状态（与 HomePage 共享同一设置源） ----------
  const [defaultPath, setDefaultPath] = useState('');
  const [verify, setVerify] = useState<AppSettings['verify']>('Full');
  const [recurse, setRecurse] = useState(true);
  const [detectLinks, setDetectLinks] = useState(false);
  const [confirmBeforeDelete, setConfirmBeforeDelete] = useState(true);
  const [quarantineDir, setQuarantineDir] = useState('');
  const [excludeDirs, setExcludeDirs] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState('');

  // ---------- 更新状态 ----------
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);

  // 启动时加载设置
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await invoke('get-app-settings');
        if (cancelled || !s) return;
        if (typeof s.defaultPath === 'string') setDefaultPath(s.defaultPath);
        if (s.verify) setVerify(s.verify);
        if (typeof s.recurse === 'boolean') setRecurse(s.recurse);
        if (typeof s.detectLinks === 'boolean') setDetectLinks(s.detectLinks);
        if (typeof s.confirmBeforeDelete === 'boolean') setConfirmBeforeDelete(s.confirmBeforeDelete);
        if (typeof s.quarantineDir === 'string') setQuarantineDir(s.quarantineDir);
        if (Array.isArray(s.excludeDirs)) setExcludeDirs(s.excludeDirs);
      } catch (e) {
        if (!cancelled) toast.error('加载设置失败: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        if (!cancelled) { setLoaded(true); loadedRef.current = true; }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 变更后持久化（初始加载完成后）
  useEffect(() => {
    if (!loadedRef.current) return;
    invoke('update-app-settings', {
      defaultPath, verify, recurse, detectLinks, confirmBeforeDelete, quarantineDir, excludeDirs
    }).catch(e => toast.error('保存设置失败: ' + (e instanceof Error ? e.message : String(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPath, verify, recurse, detectLinks, confirmBeforeDelete, quarantineDir, excludeDirs]);

  // ---------- 操作 ----------
  const handleChooseDefaultPath = useCallback(async () => {
    try {
      const r = await invoke('choose-directories');
      const paths = (r as { paths?: string[] }).paths ?? [];
      if (paths.length > 0) {
        setDefaultPath(paths[0]);
        toast.success('默认扫描目录已设置');
      }
    } catch (e) {
      toast.error('选择目录失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [toast]);

  const handleChooseQuarantineDir = useCallback(async () => {
    try {
      const r = await invoke('choose-directories');
      const paths = (r as { paths?: string[] }).paths ?? [];
      if (paths.length > 0) {
        setQuarantineDir(paths[0]);
        toast.success('隔离区位置已更新: ' + paths[0]);
      }
    } catch (e) {
      toast.error('选择隔离区目录失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [toast]);

  const handleAddExclude = useCallback(() => {
    const v = excludeInput.trim();
    if (!v) return;
    if (!excludeDirs.includes(v)) setExcludeDirs(prev => [...prev, v]);
    setExcludeInput('');
  }, [excludeInput, excludeDirs]);

  const handleCheckUpdates = useCallback(async () => {
    setChecking(true);
    setUpdate(null);
    try {
      const r = await invoke('check-updates');
      setUpdate(r);
      if (r.updateAvailable) {
        toast.success(`发现新版本 v${r.latestVersion}`);
      } else if (!r.latestVersion) {
        toast.warn('仓库暂无发布版本（发布首个 Release 后可检查更新）');
      } else {
        toast.success('当前已是最新版本');
      }
    } catch (e) {
      toast.error((e instanceof Error ? e.message : String(e)));
    } finally {
      setChecking(false);
    }
  }, [toast]);

  const handleOpenExternal = useCallback(async (url: string) => {
    try {
      await invoke('open-external', { url });
    } catch (e) {
      toast.error('打开链接失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [toast]);

  if (!loaded) {
    return (
      <div className="page-content">
        <PageHeader title="设置" description="应用偏好与安全选项。" />
        <Card><div className="aux">加载中…</div></Card>
      </div>
    );
  }

  return (
    <div className="page-content">
      <PageHeader
        title={<>设置 {isDemoMode && <DemoBadge />}</>}
        description="应用偏好与安全选项。设置实时保存，与首页扫描选项共享。"
      />

      {/* ---------- 扫描 ---------- */}
      <Card title="扫描" icon={<Globe size={15} strokeWidth={1.8} />}>
        <div className="scan-options">
          {/* 默认扫描目录 */}
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">默认扫描目录</span>
              <span className="aux">{defaultPath || '未设置（每次扫描时手动选择）'}</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {defaultPath && (
                <button type="button" className="btn btn-sm" onClick={() => setDefaultPath('')}>清除</button>
              )}
              <button type="button" className="btn btn-sm" onClick={handleChooseDefaultPath}>
                <FolderOpen size={13} />
                选择目录
              </button>
            </div>
          </div>

          {/* 校验级别 */}
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">校验级别</span>
              <span className="aux">{VERIFY_OPTIONS.find(o => o.value === verify)?.desc}</span>
            </div>
            <select
              className="select"
              style={{ width: 220 }}
              value={verify}
              onChange={e => setVerify(e.target.value as AppSettings['verify'])}
              aria-label="校验级别"
            >
              {VERIFY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* 递归子目录 */}
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">递归子目录</span>
              <span className="aux">扫描时进入子目录（关闭后只扫描当前层）</span>
            </div>
            <input type="checkbox" className="switch" checked={recurse} onChange={e => setRecurse(e.target.checked)} aria-label="递归子目录" />
          </div>

          {/* 检测硬链接 */}
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">检测硬链接</span>
              <span className="aux">同一文件的硬链接视为重复</span>
            </div>
            <input type="checkbox" className="switch" checked={detectLinks} onChange={e => setDetectLinks(e.target.checked)} aria-label="检测硬链接" />
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
                placeholder="如 node_modules 或 D:\临时"
                value={excludeInput}
                onChange={e => setExcludeInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddExclude(); } }}
                aria-label="新增排除目录"
              />
              <button type="button" className="btn" onClick={handleAddExclude} disabled={excludeInput.trim().length === 0}>
                添加
              </button>
            </div>
            {excludeDirs.length > 0 && (
              <ul className="exclude-list">
                {excludeDirs.map(d => (
                  <li key={d}>
                    <span className="mono ellipsis" title={d} style={{ flex: 1, minWidth: 0 }}>{d}</span>
                    <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`移除 ${d}`} onClick={() => setExcludeDirs(prev => prev.filter(x => x !== d))}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      {/* ---------- 清理安全 ---------- */}
      <Card title="清理安全" icon={<ShieldCheck size={15} strokeWidth={1.8} />}>
        <div className="scan-options">
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">清理前要求二次确认</span>
              <span className="aux">执行隔离 / 永久删除前弹出确认对话框（强烈建议保持开启）</span>
            </div>
            <input type="checkbox" className="switch" checked={confirmBeforeDelete} onChange={e => setConfirmBeforeDelete(e.target.checked)} aria-label="清理前要求二次确认" />
          </div>
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">默认处理方式</span>
              <span className="aux">应用默认推荐「移入隔离区」，可随时恢复；永久删除需单独确认</span>
            </div>
            <span className="tag tag-accent">隔离优先</span>
          </div>
        </div>
      </Card>

      {/* ---------- 隔离区 ---------- */}
      <Card title="隔离区" icon={<FolderOpen size={15} strokeWidth={1.8} />}>
        <div className="scan-option-row">
          <div className="scan-option-label">
            <span className="strong">隔离区位置</span>
            <span className="aux">{quarantineDir || '默认使用各扫描根目录下的 _dedup_quarantine'}</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {quarantineDir && (
              <button type="button" className="btn btn-sm" onClick={() => setQuarantineDir('')} title="恢复为默认位置">
                恢复默认
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={handleChooseQuarantineDir}>
              <FolderOpen size={13} />
              选择目录
            </button>
          </div>
        </div>
      </Card>

      {/* ---------- 关于与更新 ---------- */}
      <Card title="关于与更新" icon={<RefreshCw size={15} strokeWidth={1.8} />}>
        <div className="scan-options">
          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">版本</span>
              <span className="aux">
                当前 v1.0.0
                {update ? ` · 最新 v${update.latestVersion}（检查于 ${formatDateTime(update.checkedAt)}）` : ''}
              </span>
            </div>
            <button type="button" className="btn btn-sm" onClick={handleCheckUpdates} disabled={checking}>
              <RefreshCw size={13} className={checking ? 'spin' : undefined} />
              {checking ? '检查中…' : '检查更新'}
            </button>
          </div>

          {update?.updateAvailable && (
            <div style={{ padding: '10px 12px', background: '#DDF4FF', border: '1px solid rgba(9,105,218,0.25)', borderRadius: 'var(--radius-sm)' }}>
              <div className="strong" style={{ marginBottom: 4 }}>发现新版本 v{update.latestVersion}</div>
              {update.releaseNotes && (
                <pre className="aux" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 8px', fontFamily: 'inherit', maxHeight: 140, overflowY: 'auto' }}>
                  {update.releaseNotes.slice(0, 500)}{update.releaseNotes.length > 500 ? '…' : ''}
                </pre>
              )}
              <div className="row" style={{ gap: 8 }}>
                {update.downloadUrl && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => handleOpenExternal(update.downloadUrl!)}>
                    下载安装包
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => handleOpenExternal(update.releaseUrl)}>
                  查看发布页
                </button>
              </div>
            </div>
          )}

          {update && !update.updateAvailable && (
            <div className="tag tag-success" style={{ alignSelf: 'flex-start' }}>当前已是最新版本</div>
          )}

          <div className="scan-option-row">
            <div className="scan-option-label">
              <span className="strong">项目主页</span>
              <span className="aux">github.com/XLcode5/CleanDub</span>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => handleOpenExternal('https://github.com/XLcode5/CleanDub')}>
              <Globe size={13} />
              打开仓库
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
