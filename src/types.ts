/**
 * 渲染进程共享类型 —— 与 electron/preload.js 暴露的 IPC 通道对齐。
 * 字段命名遵循 docs/cleandub-ui/08-data-model.md。
 */

export type PageKey = 'home' | 'cleanup' | 'profile' | 'settings';

export type ScanState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ScanPhase =
  | 'enumerate'
  | 'prehash'
  | 'hash'
  | 'group'
  | 'done';

export interface ScanProgress {
  state: ScanState;
  sessionId?: number;
  phase?: ScanPhase;
  message?: string;
  current?: number;
  total?: number;
  percent?: number; // 0-100，可能为 undefined（不确定进度）
  elapsedSec?: number;
  scannedFiles?: number;
  errorCount?: number;
  currentFile?: string;
}

export interface ScanStateEvent {
  state: ScanState;
  sessionId?: number;
  error?: string;
  scannedFileCount?: number;
  duplicateGroupCount?: number;
  duplicateFileCount?: number;
  reclaimableBytes?: number;
  durationMs?: number;
}

export interface DuplicateFileItem {
  id: number;
  canonical_path?: string;
  path?: string;
  file_name?: string;
  name?: string;
  file_size?: number;
  size?: number;
  modified_at?: string;
  modifiedAt?: string | number;
  sha256?: string;
}

export interface DuplicateGroup {
  id: number;
  scan_session_id?: number;
  sha256: string;
  file_size?: number;
  fileSize?: number;
  retained_file_id?: number | null;
  files: DuplicateFileItem[];
}

export interface DuplicateGroupsResult {
  sessionId: number | null;
  groups: DuplicateGroup[];
}

export interface ScanHistoryEntry {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  scanned_file_count: number;
  duplicate_group_count: number;
  duplicate_file_count: number;
  reclaimable_bytes: number;
  duration_ms: number;
  error_summary: string | null;
  roots: string[];
}

export interface QuarantineItem {
  id: number;
  original_path: string;
  quarantine_path: string;
  session_dir: string;
  scan_root: string;
  file_name: string;
  file_size: number;
  sha256: string | null;
  quarantined_at: string;
  restored_at: string | null;
  status: 'quarantined' | 'restored' | 'deleted';
  operation_error: string | null;
}

export interface OperationLog {
  id: number;
  operation_type: string;
  target_path: string | null;
  operation_status: 'ok' | 'failed' | 'partial';
  created_at: string;
  error_message: string | null;
}

export interface AppSettings {
  defaultPath: string;
  strategy: string;
  verify: 'Full' | 'Head' | 'Name' | 'Size';
  detectLinks: boolean;
  recurse?: boolean;
  minSize?: number;
  excludeDirs: string[];
  quarantineDir?: string;
  confirmBeforeDelete?: boolean;
}

export interface UpdateCheckResult {
  ok: boolean;
  localVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl: string | null;
  releaseNotes: string;
  releaseUrl: string;
  checkedAt: string;
}

export interface ResetResult {
  ok: boolean;
  remaining: {
    scan_sessions: number;
    scanned_files: number;
    duplicate_groups: number;
    quarantine_items: number;
    operation_logs: number;
  };
}

export interface BridgeInvokeMap {
  'choose-directories': { payload?: never; result: { paths: string[] } };
  'start-scan': {
    payload: {
      roots: string[];
      options?: {
        minSize?: number;
        verify?: AppSettings['verify'];
        excludeDirs?: string[];
        /** 渲染进程会传递，主进程当前忽略亦可 */
        recurse?: boolean;
        detectLinks?: boolean;
      };
    };
    result: ScanStateEvent;
  };
  'cancel-scan': { payload?: never; result: { ok: boolean; reason?: string } };
  'get-scan-progress': { payload?: never; result: ScanProgress };
  'get-scan-history': { payload?: never; result: ScanHistoryEntry[] };
  'get-duplicate-groups': { payload?: { sessionId?: number }; result: DuplicateGroupsResult };
  'set-retained-file': { payload: { groupId: number; fileId: number }; result: { ok: boolean } };
  'apply-retention-strategy': {
    payload: { sessionId?: number; strategy: string; groupIds?: number[]; skipMarked?: boolean };
    result: { sessionId: number; strategy: string; groupsUpdated: number; skipped: number };
  };
  'quarantine-files': { payload: { fileIds: number[] }; result: { ok: number; failed: number; skipped: number } };
  'permanently-delete-files': {
    payload: { quarantineIds?: number[]; fileIds?: number[] };
    result: { ok: number; failed: number; skipped?: number; missing?: number };
  };
  'restore-quarantined-files': { payload: { quarantineIds: number[] }; result: { ok: number; failed: number; conflicts?: string[] } };
  'get-quarantine-items': { payload?: { status?: QuarantineItem['status'] }; result: QuarantineItem[] };
  'delete-scan-history': { payload: { sessionId: number }; result: { ok: boolean } };
  'get-app-settings': { payload?: never; result: AppSettings };
  'update-app-settings': { payload: Partial<AppSettings>; result: AppSettings };
  'get-operation-logs': { payload?: { limit?: number }; result: OperationLog[] };
  'reset-app-data': { payload: { scope: 'history' | 'quarantine' | 'all' }; result: ResetResult };
  'check-updates': { payload?: never; result: UpdateCheckResult };
  'open-external': { payload: { url: string }; result: { ok: boolean } };
}

export type BridgeChannel = keyof BridgeInvokeMap;

export interface CleandubBridge {
  invoke<K extends BridgeChannel>(
    channel: K,
    payload?: BridgeInvokeMap[K]['payload']
  ): Promise<BridgeInvokeMap[K]['result']>;
  on(channel: 'scan-progress' | 'scan-state', cb: (data: never) => void): () => void;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
  };
}

declare global {
  interface Window {
    cleandub?: CleandubBridge;
  }
}
