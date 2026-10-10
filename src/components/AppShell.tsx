import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import type { PageKey } from '../types';

interface AppShellProps {
  current: PageKey;
  onNavigate: (key: PageKey) => void;
  children: ReactNode;
  version?: string;
}

export function AppShell({ current, onNavigate, children, version }: AppShellProps) {
  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <Sidebar current={current} onNavigate={onNavigate} version={version} />
        <main className="main-area">{children}</main>
      </div>
    </div>
  );
}
