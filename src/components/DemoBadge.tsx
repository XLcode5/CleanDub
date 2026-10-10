import { AlertTriangle, Info } from 'lucide-react';

interface DemoBadgeProps {
  compact?: boolean;
}

/** 「演示数据」徽标 —— 规格 13 阶段二：演示模式必须在 UI 上明确可见 */
export function DemoBadge({ compact }: DemoBadgeProps) {
  return (
    <span className="tag tag-demo" title="当前数据来源为内置演示数据，并非真实扫描结果">
      <AlertTriangle size={11} strokeWidth={2.2} />
      {compact ? '演示' : '演示数据'}
    </span>
  );
}

interface DemoBannerProps {
  text?: string;
}

export function DemoBanner({ text }: DemoBannerProps) {
  return (
    <div className="demo-banner" role="note">
      <Info size={14} strokeWidth={2} />
      <span>{text ?? '当前界面展示的是演示数据，用于验证 UI。接入真实扫描后此处将被实际结果替换。'}</span>
    </div>
  );
}
