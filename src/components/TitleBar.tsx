import { Minus, Square, X, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { bridge, isDemoMode } from '../bridge';

/** 自定义标题栏 —— 配合 Electron frame:false 使用，拖拽区与窗口控制按钮分离 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isDemoMode) {
      bridge.window.isMaximized().then(v => { if (!cancelled) setMaximized(v); }).catch(() => {});
      const onResize = () => {
        bridge.window.isMaximized().then(v => { if (!cancelled) setMaximized(v); }).catch(() => {});
      };
      window.addEventListener('resize', onResize);
      return () => { cancelled = true; window.removeEventListener('resize', onResize); };
    }
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-title">
        <span>CleanDub</span>
        {isDemoMode && <span className="tag tag-warn" style={{ marginLeft: 4 }}>浏览器演示</span>}
      </div>
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          aria-label="最小化"
          onClick={() => bridge.window.minimize()}
        >
          <Minus size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => {
            bridge.window.toggleMaximize();
            setMaximized(v => !v);
          }}
        >
          {maximized
            ? <Copy size={12} strokeWidth={1.8} style={{ transform: 'scaleX(-1)' }} />
            : <Square size={12} strokeWidth={1.8} />}
        </button>
        <button
          type="button"
          className="titlebar-btn close"
          aria-label="关闭"
          onClick={() => bridge.window.close()}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
