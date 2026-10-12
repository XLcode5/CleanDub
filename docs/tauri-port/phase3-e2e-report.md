# Phase 3 端到端验证报告 — v1.2.0 Tauri 重构

> 日期：2026-10-12 · 分支：feat/tauri-v2 · 产物：CleanDub_1.2.0_x64-setup.exe
> 验证方式：UIA（Windows UI Automation + MSAA DoDefaultAction）驱动真实 UI + SQLite/磁盘双断言

## 测试矩阵

| # | 场景 | 断言 | 结果 |
|---|------|------|------|
| 1 | UI 三页加载（首页/清理/个人中心） | UIA 树完整渲染 React DOM | ✅ |
| 2 | rfd 目录选择对话框 | UIA ValuePattern 填路径 →「选择文件夹」确认 → React directories 更新 | ✅ |
| 3 | 扫描引擎 | 6 文件扫描 → 2 重复组 / 5 重复文件 / 50,208B 可回收（104×2+50000 精确） | ✅ |
| 4 | 会话持久化 | scan_sessions(id=1, completed) + scanned_files 5 行 + duplicate_groups 2 行 | ✅ |
| 5 | 保留标记 | 点「保留此文件」(b-dup) → retained_file_id 指向 b-dup.txt | ✅ |
| 6 | 直删通道（清理页） | 勾选 a-dup + sub/f-dup → 确认 → 磁盘真删（递归含子目录） | ✅ |
| 7 | 保留文件保护 | 直删后 b-dup.txt 完好（retained_file_id 过滤生效） | ✅ |
| 8 | 隔离通道 | d-big → `_dedup_quarantine/20261012_202415-8b7b25/` + manifest.json（camelCase 双向兼容格式） | ✅ |
| 9 | 隔离 SQLite 回读 | quarantine_items：original_path/quarantine_path/session_dir/status=quarantined | ✅ |
| 10 | 还原通道 | 「批量恢复」→ 确认 → d-big.bin 原名回归（无 .restored 后缀） | ✅ |
| 11 | 还原状态落库 | quarantine_items status=restored + restored_at 时间戳 | ✅ |
| 12 | 操作日志 | operation_logs：(delete,ok) (quarantine,ok) (restore,ok) 三连 | ✅ |
| 13 | 引擎审计日志 | `_dedup_logs/ops.jsonl` 随直删生成 | ✅ |
| 14 | 隔离区全选 UI | 表头三态 checkbox「全选隔离区文件」+ 批量永久删除按钮 | ✅ |
| 15 | 确认框体系 | 直删红字警告「永久删除（不可恢复）」/「确认隔离选中文件」/「恢复隔离区文件」 | ✅ |

## 测试数据

```
C:\Users\Admin\AppData\Local\Temp\cleandub-e2e\
├── a-dup.txt (104B) ┐
├── b-dup.txt (104B) ├─ 同 SHA-256（小文件组，3 副本）
├── sub\f-dup.txt   ┘
├── c-big.bin (50KB) ┐ 随机不可压缩（大文件组，走 prehash+全量双段）
├── d-big.bin (50KB) ┘
└── e-unique.txt (280B) 唯一文件
```

## 关键技术记录（UI 驱动）

1. **WebView2 CDP 端口注入失败**：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量在 Popen 传递下不生效（浏览器实例缓存）
2. **UIA legacy 坐标陷阱**：`Chrome_RenderWidgetHostHWND` 的 UIA BoundingRectangle 返回屏幕外假坐标，Click() 无效
3. **MSAA 通道可用**：`GetLegacyIAccessiblePattern().DoDefaultAction()` 可靠触发 React onClick（无坐标依赖）
4. **rfd 对话框**：`#32770` 标准对话框，UIA ValuePattern 直接 SetValue 路径
5. **vision_analyze 不可靠**：对 CleanDub UI 产生幻觉（编造不存在的界面），废弃；Windows OCR（Windows.Media.Ocr）+ UIA Name 属性可替代

## 版本号统一

发现三处不一致 → 统一 1.2.0：
- `package.json` 1.0.2 → 1.2.0（UI 侧栏 `v${__APP_VERSION__}` 来源）
- `src-tauri/Cargo.toml` 0.1.0 → 1.2.0（`check_updates` 的 currentVersion 来源）
- `src-tauri/tauri.conf.json` 1.2.0（不变，NSIS 包版本）

## 结论

**19 个 IPC commands 全链路（真引擎 + 真落库 + 真 UI）行为与 v1.0.2 对齐**，可进入 Phase 4（合并 main + tag + Release）。
