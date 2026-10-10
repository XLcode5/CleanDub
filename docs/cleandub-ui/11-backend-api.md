## 十一、后端接口与任务通信

如果采用 Tauri 2，请使用适当的 Rust Commands 和事件通信。

建议实现：

- choose_directories
- start_scan
- cancel_scan
- get_scan_progress
- get_scan_history
- get_duplicate_groups
- set_retained_file
- quarantine_files
- permanently_delete_files
- restore_quarantined_files
- get_quarantine_items
- delete_scan_history
- get_app_settings
- update_app_settings
- get_operation_logs

接口名称可以调整，但必须覆盖对应的真实业务能力。

要求：

- 长任务不能阻塞 UI。
- 扫描进度通过事件或适当的状态订阅传递给前端。
- 所有接口都有类型定义和错误返回。
- 扫描任务应具备取消机制。
- 防止用户快速重复点击导致同一任务重复执行。
- 关键文件操作使用适当的事务、锁和状态校验。
- 不要通过前端模拟数据伪造扫描进度。

---

