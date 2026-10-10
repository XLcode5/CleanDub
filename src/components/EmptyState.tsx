import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Icon ? <Icon size={36} strokeWidth={1.5} /> : null}
      <div className="empty-state-title">{title}</div>
      {description ? <div className="empty-state-desc">{description}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}
