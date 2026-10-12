/**
 * Bridge —— 封装 window.cleandub，使纯浏览器 dev 环境可以运行（演示模式）。
 *
 * 规格 13 阶段二：演示数据必须与正式运行模式分离、不得伪装成真实扫描结果。
 * 因此 isDemoMode 在 App.tsx 中读取后贯穿 UI，所有数据卡片叠加「演示数据」徽标。
 */
import {
  demoGroups,
  demoHistory,
  demoLogs,
  demoQuarantine,
  demoSettings
} from './demoData';
import type {
  AppSettings,
  BridgeChannel,
  BridgeInvokeMap,
  CleandubBridge,
  DuplicateGroupsResult,
  ScanProgress,
  ScanStateEvent
} from './types';

// v1.2.0 静态导入（vite 动态 import 会生成分包 chunk，在 tauri:// 嵌入资产协议下加载失败 → 改静态打进主 bundle）
// 模块顶层仅注册回调转换器，浏览器演示模式加载无害（调用时才访问 __TAURI_INTERNALS__）
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWindow as tauriCurrentWindow } from '@tauri-apps/api/window';

// v1.2.0 Tauri 适配：三态 bridge（Tauri > Electron > 浏览器演示）
const isTauriRuntime: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const isDemoMode: boolean =
  !isTauriRuntime && (typeof window === 'undefined' || !window.cleandub);

type Listeners = { [K in 'scan-progress' | 'scan-state']: Set<(d: never) => void> };
const listeners: Listeners = {
  'scan-progress': new Set(),
  'scan-state': new Set()
};

function emitProgress(p: ScanProgress) {
  listeners['scan-progress'].forEach(cb => {
    try { (cb as (d: ScanProgress) => void)(p); } catch { /* noop */ }
  });
}
function emitState(s: ScanStateEvent) {
  listeners['scan-state'].forEach(cb => {
    try { (cb as (d: ScanStateEvent) => void)(s); } catch { /* noop */ }
  });
}

// ---------- 演示模式状态 ----------
let demoScanTimer: number | null = null;
let demoScanProgress = 0;

function stopDemoScan() {
  if (demoScanTimer !== null) {
    window.clearInterval(demoScanTimer);
    demoScanTimer = null;
  }
}

async function demoInvoke<K extends BridgeChannel>(
  channel: K,
  payload?: BridgeInvokeMap[K]['payload']
): Promise<BridgeInvokeMap[K]['result']> {
  // 模拟网络延迟
  await new Promise(r => setTimeout(r, 120));

  switch (channel) {
    case 'choose-directories':
      return { paths: ['D:\\示例\\新目录'] } as BridgeInvokeMap[K]['result'];

    case 'start-scan': {
      const p = payload as BridgeInvokeMap['start-scan']['payload'];
      if (!p || !Array.isArray(p.roots) || p.roots.length === 0) {
        throw new Error('至少选择一个扫描目录');
      }
      stopDemoScan();
      demoScanProgress = 0;
      const sessionId = Math.floor(Math.random() * 10000) + 100;
      emitState({ state: 'running', sessionId });
      demoScanTimer = window.setInterval(() => {
        demoScanProgress += Math.random() * 8 + 2;
        const total = 8432;
        const current = Math.min(total, Math.floor((demoScanProgress / 100) * total));
        emitProgress({
          state: 'running',
          sessionId,
          phase: demoScanProgress < 30 ? 'enumerate' : demoScanProgress < 70 ? 'hash' : 'group',
          message: demoScanProgress < 30 ? '正在枚举文件…' : demoScanProgress < 70 ? '正在计算 SHA-256…' : '正在识别重复文件…',
          current,
          total,
          percent: Math.min(100, demoScanProgress),
          elapsedSec: (demoScanProgress * 0.08),
          scannedFiles: current,
          errorCount: 0,
          currentFile: `D:\\示例\\照片库\\子目录\\文件_${String(current).padStart(4, '0')}.dat`
        });
        if (demoScanProgress >= 100) {
          stopDemoScan();
          emitState({
            state: 'completed',
            sessionId,
            scannedFileCount: total,
            duplicateGroupCount: 47,
            duplicateFileCount: 132,
            reclaimableBytes: 3_214_557_184,
            durationMs: 95_000
          });
        }
      }, 200);
      return { state: 'running', sessionId } as BridgeInvokeMap[K]['result'];
    }

    case 'cancel-scan':
      stopDemoScan();
      emitState({ state: 'cancelled' });
      return { ok: true } as BridgeInvokeMap[K]['result'];

    case 'get-scan-progress':
      return (demoScanTimer !== null
        ? {
            state: 'running',
            current: Math.floor(demoScanProgress * 84),
            total: 8432,
            percent: Math.min(100, demoScanProgress)
          }
        : { state: 'idle' }) as BridgeInvokeMap[K]['result'];

    case 'get-scan-history':
      return demoHistory as BridgeInvokeMap[K]['result'];

    case 'get-duplicate-groups':
      return {
        sessionId: 12,
        groups: demoGroups
      } as DuplicateGroupsResult as BridgeInvokeMap[K]['result'];

    case 'set-retained-file':
      return { ok: true } as BridgeInvokeMap[K]['result'];

    case 'apply-retention-strategy': {
      const p = payload as BridgeInvokeMap['apply-retention-strategy']['payload'];
      return { sessionId: p?.sessionId ?? 0, strategy: p?.strategy ?? 'Cleanest', groupsUpdated: 0, skipped: 0 } as BridgeInvokeMap[K]['result'];
    }

    case 'quarantine-files': {
      const p = payload as BridgeInvokeMap['quarantine-files']['payload'];
      const n = p?.fileIds?.length ?? 0;
      return { ok: n, failed: 0, skipped: 0 } as BridgeInvokeMap[K]['result'];
    }

    case 'permanently-delete-files': {
      const p = payload as BridgeInvokeMap['permanently-delete-files']['payload'];
      const n = p?.fileIds?.length ?? p?.quarantineIds?.length ?? 0;
      return { ok: n, failed: 0 } as BridgeInvokeMap[K]['result'];
    }

    case 'restore-quarantined-files': {
      const p = payload as BridgeInvokeMap['restore-quarantined-files']['payload'];
      const n = p?.quarantineIds?.length ?? 0;
      return { ok: n, failed: 0 } as BridgeInvokeMap[K]['result'];
    }

    case 'get-quarantine-items':
      return demoQuarantine as BridgeInvokeMap[K]['result'];

    case 'delete-scan-history':
      return { ok: true } as BridgeInvokeMap[K]['result'];

    case 'get-app-settings':
      return demoSettings as BridgeInvokeMap[K]['result'];

    case 'update-app-settings': {
      const p = payload as Partial<AppSettings> | undefined;
      return { ...demoSettings, ...(p ?? {}) } as BridgeInvokeMap[K]['result'];
    }

    case 'get-operation-logs':
      return demoLogs as BridgeInvokeMap[K]['result'];

    case 'check-updates':
      return {
        ok: true,
        localVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
        downloadUrl: null,
        releaseNotes: '演示模式：此处将显示 GitHub Release 说明。',
        releaseUrl: 'https://github.com/XLcode5/CleanDub/releases',
        checkedAt: new Date().toISOString()
      } as BridgeInvokeMap[K]['result'];

    case 'open-external':
      return { ok: true } as BridgeInvokeMap[K]['result'];

    case 'reset-app-data':
      return {
        ok: true,
        remaining: { scan_sessions: 0, scanned_files: 0, duplicate_groups: 0, quarantine_items: 0, operation_logs: 0 }
      } as BridgeInvokeMap[K]['result'];

    default:
      throw new Error('演示模式不支持的通道: ' + String(channel));
  }
}

// ---------- Tauri 适配器（v1.2.0）----------

type UnlistenFn = () => void;

function makeTauriBridge(): CleandubBridge {
  // 静态导入的 Tauri API（见文件顶部 import，已打进主 bundle）

  const pendingUnlistens: Array<Promise<UnlistenFn>> = [];
  let destroyed = false;

  const bridge: CleandubBridge = {
    async invoke(channel, payload) {
      // Tauri 2 command 名 = Rust 函数名原样（snake_case，tauri-macros stringify! 规则）
      // Electron 遗留通道名是 kebab-case(get-app-settings) → 转 snake_case(get_app_settings)
      const snake = String(channel).replace(/-/g, '_');
      return tauriInvoke(snake, (payload ?? {}) as Record<string, unknown>);
    },
    on(channel, cb) {
      const p: Promise<UnlistenFn> = tauriListen(channel, (e: { payload: unknown }) => {
        (cb as (d: unknown) => void)(e.payload);
      });
      pendingUnlistens.push(p);
      return () => {
        p.then(fn => fn()).catch(() => undefined);
      };
    },
    window: {
      minimize() { tauriCurrentWindow().minimize().catch(() => undefined); },
      toggleMaximize() { tauriCurrentWindow().toggleMaximize().catch(() => undefined); },
      close() { tauriCurrentWindow().close().catch(() => undefined); },
      async isMaximized() {
        try { return await tauriCurrentWindow().isMaximized(); }
        catch { return false; }
      }
    }
  };
  // 防止 unmount 后悬挂监听
  window.addEventListener('beforeunload', () => {
    if (destroyed) return;
    destroyed = true;
    pendingUnlistens.forEach(p => p.then(fn => fn()).catch(() => undefined));
  });
  return bridge;
}

// ---------- 导出统一 bridge ----------

export const bridge: CleandubBridge = isDemoMode
  ? {
      invoke: demoInvoke,
      on(channel, cb) {
        listeners[channel].add(cb);
        return () => listeners[channel].delete(cb);
      },
      window: {
        minimize() { /* noop in browser */ },
        toggleMaximize() { /* noop */ },
        close() { window.close(); },
        async isMaximized() { return false; }
      }
    }
  : isTauriRuntime
    ? makeTauriBridge()
    : (window.cleandub as CleandubBridge);

export function invoke<K extends BridgeChannel>(
  channel: K,
  payload?: BridgeInvokeMap[K]['payload']
): Promise<BridgeInvokeMap[K]['result']> {
  // 主进程统一 {ok, data} / {ok, error, code} 信封（规格 11）；这里统一拆包。
  // 演示模式（bridge.invoke=demoInvoke）返回裸数据，跳过拆包。
  return bridge.invoke(channel, payload).then((res: unknown) => {
    if (res && typeof res === 'object' && 'ok' in (res as Record<string, unknown>)) {
      const env = res as { ok: boolean; data?: unknown; error?: string; code?: string };
      if (env.ok) return env.data as BridgeInvokeMap[K]['result'];
      throw new Error(env.error || ('IPC 调用失败' + (env.code ? ` (${env.code})` : '')));
    }
    return res as BridgeInvokeMap[K]['result'];
  });
}

export function onScanProgress(cb: (p: ScanProgress) => void): () => void {
  return bridge.on('scan-progress', cb as never);
}

export function onScanState(cb: (s: ScanStateEvent) => void): () => void {
  return bridge.on('scan-state', cb as never);
}
