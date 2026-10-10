## 八、数据模型与持久化

使用 SQLite 保存数据。

建议至少包含以下数据实体：

### ScanSession

字段：

- id
- started_at
- completed_at
- status
- scanned_file_count
- duplicate_group_count
- duplicate_file_count
- reclaimable_bytes
- duration_ms
- error_summary

### ScanRoot

字段：

- id
- scan_session_id
- directory_path

### ScannedFile

字段：

- id
- scan_session_id
- canonical_path
- file_name
- extension
- file_size
- modified_at
- sha256
- scan_status
- error_message

### DuplicateGroup

字段：

- id
- scan_session_id
- sha256
- file_size
- retained_file_id

### QuarantineItem

字段：

- id
- original_path
- quarantine_path
- file_name
- file_size
- sha256
- quarantined_at
- restored_at
- status
- operation_error

### OperationLog

字段：

- id
- operation_type
- target_path
- operation_status
- created_at
- error_message

请根据实际实现调整数据表之间的关联关系、索引、事务和约束。

要求：

- 使用数据库迁移或可靠的初始化逻辑。
- 应用重启后仍能查看扫描历史和隔离区。
- 数据库写入失败时不能继续执行依赖该记录的危险操作。
- 删除历史记录时保留隔离区恢复所需的数据。
- 对路径、哈希、文件大小和状态进行必要校验。
- 对长时间运行任务进行合理的并发控制。

---

