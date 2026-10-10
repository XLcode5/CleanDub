import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}

export function StatCard({ label, value, hint, icon }: StatCardProps) {
  return (
    <div className="card stat-card" style={{ padding: '12px 14px' }}>
      <div className="row" style={{ gap: 6, marginBottom: 4 }}>
        {icon ? <span style={{ color: 'var(--text2)', display: 'inline-flex' }}>{icon}</span> : null}
        <div className="aux">{label}</div>
      </div>
      <div
        className="num-strong"
        style={{ fontSize: 22, color: 'var(--ink)', lineHeight: 1.2 }}
      >
        {value}
      </div>
      {/* hint 占位始终渲染一行，避免有无 hint 时高度不齐 */}
      <div
        className="aux-sm"
        style={{ marginTop: 4, minHeight: 15, visibility: hint ? 'visible' : 'hidden' }}
      >
        {hint ?? ' '}
      </div>
    </div>
  );
}
