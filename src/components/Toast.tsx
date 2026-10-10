import { CheckCircle2, AlertTriangle, Info, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  push: (kind: ToastKind, message: string) => void;
  success: (m: string) => void;
  error: (m: string) => void;
  info: (m: string) => void;
  warn: (m: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++idRef.current;
    setItems(prev => [...prev, { id, kind, message }]);
    window.setTimeout(() => {
      setItems(prev => prev.filter(t => t.id !== id));
    }, 3600);
  }, []);

  const value = useMemo<ToastContextValue>(() => ({
    push,
    success: (m: string) => push('success', m),
    error: (m: string) => push('error', m),
    info: (m: string) => push('info', m),
    warn: (m: string) => push('warn', m)
  }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" aria-live="polite" aria-atomic="false">
        {items.map(t => {
          const Icon =
            t.kind === 'success' ? CheckCircle2
            : t.kind === 'error' ? XCircle
            : t.kind === 'warn' ? AlertTriangle
            : Info;
          const color =
            t.kind === 'success' ? 'var(--success)'
            : t.kind === 'error' ? 'var(--danger)'
            : t.kind === 'warn' ? 'var(--warning)'
            : 'var(--accent)';
          return (
            <div key={t.id} className={`toast toast-${t.kind}`} role="status">
              <Icon size={16} strokeWidth={2} style={{ color, flexShrink: 0, marginTop: 2 }} />
              <div>{t.message}</div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
