# CleanDub Electron 主进程（A 代理负责范围）

本目录只包含 **Electron 主进程 / 预加载脚本 / Node 端业务逻辑**。React 前端源码位于 `src/`（B 代理负责），不在这里。

## 结构

| 文件 | 职责 |
|---|---|
| `main.js` | 窗口生命周期、单实例锁、自定义标题栏控件、服务装配 |
| `preload.js` | contextIsolation 桥接，暴露 `window.cleandub.invoke/on` + `window.cleandub.window.*` |
| `ipc.js` | 全部 IPC handler，统一 `{ ok, data } / { ok, error, code? }` 协议 |
| `scanner.js` | 三段流水线扫描引擎：枚举 → 大小分组 → 头部 32KB prehash → 全量 SHA-256（流式） |
| `quarantine.js` | 隔离区：manifest.json / ops.jsonl，与 `dedup_core.ps1` 和 `QuarantineManager.cs` 逐字节兼容 |
| `db.js` | SQLite（better-sqlite3）：`scan_sessions / scan_roots / scanned_files / duplicate_groups / quarantine_items / operation_logs` |
| `settings.js` | 设置持久化，字段名沿用 `appsettings.json`：`defaultPath / strategy / verify / detectLinks / excludeDirs` |
| `smoke.test.js` | 冒烟测试（`node electron/smoke.test.js`，不启动 GUI） |
| `boot-test.js` | Electron runtime 启动验证（`electron electron/boot-test.js`） |

## IPC 通道（preload 白名单）

`choose-directories`, `start-scan`, `cancel-scan`, `get-scan-progress`, `get-scan-history`,
`get-duplicate-groups`, `set-retained-file`, `quarantine-files`, `permanently-delete-files`,
`restore-quarantined-files`, `get-quarantine-items`, `delete-scan-history`,
`get-app-settings`, `update-app-settings`, `get-operation-logs`

事件：`scan-progress`（进行中，含 phase/percent/message）、`scan-state`（running/completed/cancelled/failed）。

## 与 PowerShell 版的兼容约定（必须遵守）

1. **扫描排除目录**（与 `dedup_core.ps1` 一致）：`$RECYCLE.BIN`、`System Volume Information`、`.git`、`node_modules`、`_dedup_quarantine`、`_dedup_logs`。
2. **隔离区**：`<scanRoot>/_dedup_quarantine/<yyyyMMdd_HHmmss>-<6位hex>/manifest.json`，
   条目字段：`original / stored / size / movedAt`（`movedAt` 为本地 ISO `"s"` 格式，无时区）。
3. **操作日志**：`<scanRoot>/_dedup_logs/ops.jsonl`，append-only JSONL，UTF-8 无 BOM，紧凑 JSON。
4. **三段流水线**：大小分组 → 头部 32KB prehash → 全量 SHA-256。流式读取（1MB 缓冲），绝不整文件载入内存。
5. **安全**：所有文件操作先 `path.resolve` + 验证在扫描根内 + `fs.stat` 复查；Move 失败回退 Copy+校验大小+Delete；还原时来源必须在隔离区 session 内，目标冲突时追加 `.restored`。

## 常用命令

```bash
npm install          # 安装依赖（已含 electron / electron-builder / better-sqlite3）
npm run dev          # 并行起 vite(5173) + electron（开发模式，B 代理完成后可用）
npm start            # 仅启动 electron（加载 dist-renderer 或 vite dev server）
node electron/smoke.test.js        # 扫描/隔离/还原/删除/日志 全链路冒烟测试
electron electron/boot-test.js     # Electron runtime 内 SQLite 启动验证
npm run build        # vite build + electron-builder --win
```
