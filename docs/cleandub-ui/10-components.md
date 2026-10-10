## 十、前端组件拆分建议

建议采用以下组件结构：

- AppShell
- Sidebar
- WindowTitleBar
- PageHeader
- StatCard
- FolderPicker
- ScanProgressCard
- ScanResultSummary
- FileTypeSidebar
- DuplicateGroupList
- DuplicateGroupItem
- FilePreviewPanel
- FileDetailsDialog
- ConfirmDialog
- ToastProvider
- ScanHistoryTable
- QuarantineTable
- QuarantineDetailsDialog
- EmptyState
- ErrorState
- LoadingState
- SettingsPanel

页面建议拆分为：

- HomePage
- CleanupPage
- ProfilePage
- QuarantinePage
- SettingsPage

组件之间通过明确的 Props、回调和类型定义通信。

避免组件承担过多职责。

---

