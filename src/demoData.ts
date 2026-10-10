/**
 * 演示数据 —— 仅在 window.cleandub 未注入时（纯浏览器 dev 模式）启用。
 * 规格 13 阶段二：演示数据必须与正式运行模式分离、不得伪装成真实扫描结果。
 * 因此 isDemoMode 标志贯穿 UI，所有数据卡片叠加「演示数据」徽标。
 */
import type {
  AppSettings,
  DuplicateGroup,
  OperationLog,
  QuarantineItem,
  ScanHistoryEntry
} from './types';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

export const demoSettings: AppSettings = {
  defaultPath: 'D:\\示例\\照片库',
  strategy: 'Cleanest',
  verify: 'Full',
  detectLinks: false,
  excludeDirs: ['node_modules', '$RECYCLE.BIN']
};

export const demoHistory: ScanHistoryEntry[] = [
  {
    id: 12,
    started_at: iso(2 * 3600_000),
    completed_at: iso(2 * 3600_000 - 95_000),
    status: 'completed',
    scanned_file_count: 8432,
    duplicate_group_count: 47,
    duplicate_file_count: 132,
    reclaimable_bytes: 3_214_557_184,
    duration_ms: 95_000,
    error_summary: null,
    roots: ['D:\\示例\\照片库', 'D:\\示例\\下载']
  },
  {
    id: 11,
    started_at: iso(26 * 3600_000),
    completed_at: iso(26 * 3600_000 - 60_000),
    status: 'cancelled',
    scanned_file_count: 3102,
    duplicate_group_count: 0,
    duplicate_file_count: 0,
    reclaimable_bytes: 0,
    duration_ms: 60_000,
    error_summary: '用户取消',
    roots: ['D:\\示例\\照片库']
  },
  {
    id: 10,
    started_at: iso(3 * 24 * 3600_000),
    completed_at: iso(3 * 24 * 3600_000 - 180_000),
    status: 'completed',
    scanned_file_count: 15240,
    duplicate_group_count: 89,
    duplicate_file_count: 241,
    reclaimable_bytes: 8_591_468_544,
    duration_ms: 180_000,
    error_summary: '2 个文件无法读取，已跳过',
    roots: ['D:\\示例\\工作目录']
  },
  {
    id: 9,
    started_at: iso(7 * 24 * 3600_000),
    completed_at: iso(7 * 24 * 3600_000 - 5_000),
    status: 'failed',
    scanned_file_count: 156,
    duplicate_group_count: 0,
    duplicate_file_count: 0,
    reclaimable_bytes: 0,
    duration_ms: 5_000,
    error_summary: '扫描目录不可访问',
    roots: ['D:\\不存在目录']
  }
];

export const demoGroups: DuplicateGroup[] = [
  {
    id: 1,
    sha256: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2',
    file_size: 4_523_008,
    retained_file_id: 101,
    files: [
      {
        id: 101,
        canonical_path: 'D:\\示例\\照片库\\2024-春节\\全家福.jpg',
        file_name: '全家福.jpg',
        file_size: 4_523_008,
        modified_at: iso(200 * 24 * 3600_000)
      },
      {
        id: 102,
        canonical_path: 'D:\\示例\\照片库\\备份\\全家福.jpg',
        file_name: '全家福.jpg',
        file_size: 4_523_008,
        modified_at: iso(150 * 24 * 3600_000)
      },
      {
        id: 103,
        canonical_path: 'D:\\示例\\下载\\IMG_0001.jpg',
        file_name: 'IMG_0001.jpg',
        file_size: 4_523_008,
        modified_at: iso(80 * 24 * 3600_000)
      }
    ]
  },
  {
    id: 2,
    sha256: 'F9E8D7C6B5A4938271605F4E3D2C1B0A9F8E7D6C5B4A39281706F5E4D3C2B1A09F8E',
    file_size: 12_582_912,
    retained_file_id: null,
    files: [
      {
        id: 201,
        canonical_path: 'D:\\示例\\视频\\旅行记录.mp4',
        file_name: '旅行记录.mp4',
        file_size: 12_582_912,
        modified_at: iso(90 * 24 * 3600_000)
      },
      {
        id: 202,
        canonical_path: 'D:\\示例\\下载\\旅行记录.mp4',
        file_name: '旅行记录.mp4',
        file_size: 12_582_912,
        modified_at: iso(60 * 24 * 3600_000)
      }
    ]
  },
  {
    id: 3,
    sha256: '001122334455667788990AABBCCDDEEFF001122334455667788990AABBCCDDEEFF00',
    file_size: 246_784,
    retained_file_id: 301,
    files: [
      {
        id: 301,
        canonical_path: 'D:\\示例\\文档\\2025-季度报告.docx',
        file_name: '2025-季度报告.docx',
        file_size: 246_784,
        modified_at: iso(30 * 24 * 3600_000)
      },
      {
        id: 302,
        canonical_path: 'D:\\示例\\文档\\备份\\2025-季度报告.docx',
        file_name: '2025-季度报告.docx',
        file_size: 246_784,
        modified_at: iso(28 * 24 * 3600_000)
      }
    ]
  },
  {
    id: 4,
    sha256: 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
    file_size: 18_350_080,
    retained_file_id: null,
    files: [
      {
        id: 401,
        canonical_path: 'D:\\示例\\下载\\安装包.zip',
        file_name: '安装包.zip',
        file_size: 18_350_080,
        modified_at: iso(10 * 24 * 3600_000)
      },
      {
        id: 402,
        canonical_path: 'D:\\示例\\备份\\安装包.zip',
        file_name: '安装包.zip',
        file_size: 18_350_080,
        modified_at: iso(9 * 24 * 3600_000)
      }
    ]
  },
  {
    id: 5,
    sha256: '1122334455667788990011223344556677889900112233445566778899001122AABB',
    file_size: 4_198_400,
    retained_file_id: null,
    files: [
      {
        id: 501,
        canonical_path: 'D:\\示例\\音乐\\钢琴曲.mp3',
        file_name: '钢琴曲.mp3',
        file_size: 4_198_400,
        modified_at: iso(60 * 24 * 3600_000)
      },
      {
        id: 502,
        canonical_path: 'D:\\示例\\音乐\\收藏\\钢琴曲.mp3',
        file_name: '钢琴曲.mp3',
        file_size: 4_198_400,
        modified_at: iso(45 * 24 * 3600_000)
      }
    ]
  }
];

export const demoQuarantine: QuarantineItem[] = [
  {
    id: 501,
    original_path: 'D:\\示例\\下载\\旧照片.jpg',
    quarantine_path: '%APPDATA%\\CleanDub\\quarantine\\20251010\\旧照片.jpg',
    session_dir: '20251010',
    scan_root: 'D:\\示例\\下载',
    file_name: '旧照片.jpg',
    file_size: 1_835_008,
    sha256: 'A1B2C3D4E5F6',
    quarantined_at: iso(2 * 3600_000),
    restored_at: null,
    status: 'quarantined',
    operation_error: null
  },
  {
    id: 502,
    original_path: 'D:\\示例\\下载\\重复文档.docx',
    quarantine_path: '%APPDATA%\\CleanDub\\quarantine\\20251010\\重复文档.docx',
    session_dir: '20251010',
    scan_root: 'D:\\示例\\下载',
    file_name: '重复文档.docx',
    file_size: 152_064,
    sha256: 'F9E8D7C6B5A4',
    quarantined_at: iso(2 * 3600_000),
    restored_at: null,
    status: 'quarantined',
    operation_error: null
  },
  {
    id: 503,
    original_path: 'D:\\示例\\文档\\老报告.pdf',
    quarantine_path: '%APPDATA%\\CleanDub\\quarantine\\20251008\\老报告.pdf',
    session_dir: '20251008',
    scan_root: 'D:\\示例\\文档',
    file_name: '老报告.pdf',
    file_size: 521_216,
    sha256: '0011223344',
    quarantined_at: iso(48 * 3600_000),
    restored_at: iso(24 * 3600_000),
    status: 'restored',
    operation_error: null
  }
];

export const demoLogs: OperationLog[] = [
  { id: 1, operation_type: 'quarantine', target_path: 'D:\\示例\\下载\\旧照片.jpg', operation_status: 'ok', created_at: iso(2 * 3600_000), error_message: null },
  { id: 2, operation_type: 'quarantine', target_path: 'D:\\示例\\下载\\重复文档.docx', operation_status: 'ok', created_at: iso(2 * 3600_000), error_message: null },
  { id: 3, operation_type: 'restore', target_path: 'D:\\示例\\文档\\老报告.pdf', operation_status: 'ok', created_at: iso(24 * 3600_000), error_message: null },
  { id: 4, operation_type: 'scan', target_path: 'D:\\示例\\照片库', operation_status: 'ok', created_at: iso(2 * 3600_000 + 60_000), error_message: null }
];
