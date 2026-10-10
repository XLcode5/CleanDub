import { AlertTriangle, HelpCircle, Info, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export type ConfirmTone = 'info' | 'warn' | 'danger';

interface ConfirmDialogProps {
  open: boolean;
  tone?: ConfirmTone;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/** 规格 04：禁止使用浏览器原生 alert —— 统一自实现确认对话框 */
export function ConfirmDialog({
  open,
  tone = 'info',
  title,
  children,
  confirmLabel = '确定',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
  busy
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const Icon = tone === 'danger' ? AlertTriangle : tone === 'warn' ? HelpCircle : Info;
  const iconColor =
    tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warning)' : 'var(--accent)';

  return (
    <div
      className="dialog-overlay"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="dialog-header">
          <h3 className="dialog-title">
            <Icon size={18} strokeWidth={2} style={{ color: iconColor }} />
            {title}
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onCancel}
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        <footer className="dialog-footer">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
