import { Files, Home, Settings, User } from 'lucide-react';
import type { PageKey } from '../types';

interface SidebarProps {
  current: PageKey;
  onNavigate: (key: PageKey) => void;
  version?: string;
}

const NAV_ITEMS: Array<{ key: PageKey; label: string; icon: typeof Home }> = [
  { key: 'home', label: '首页', icon: Home },
  { key: 'cleanup', label: '清理', icon: Files },
  { key: 'profile', label: '个人中心', icon: User }
];

/** 左侧固定导航 —— 规格 04：160-180px 宽 + 当前页浅蓝色高亮 + 底部版本号 */
export function Sidebar({ current, onNavigate, version = 'v1.0.0' }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <svg
          className="logo"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 8v13H3V8" />
          <path d="M23 3H1l2 5h18l2-5z" />
          <path d="M10 12h4" />
        </svg>
        <span>CleanDub</span>
      </div>
      <nav className="sidebar-nav" aria-label="主导航">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon;
          const active = current === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={`sidebar-item${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <span className="sidebar-version">{version}</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label="设置"
          title="设置"
          onClick={() => onNavigate('settings')}
        >
          <Settings size={14} strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
}
