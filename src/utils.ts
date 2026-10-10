/** 数字与日期格式化工具 */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

export function formatCount(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  if (m < 60) return `${m} 分 ${rs} 秒`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} 时 ${rm} 分`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  const days = Math.floor(diff / (24 * 3600_000));
  if (days < 30) return `${days} 天前`;
  return formatDateTime(iso);
}

/** 从完整路径取文件名（不依赖 Node path） */
export function baseName(p: string | undefined | null): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** 取扩展名（小写、无点） */
export function extOf(name: string | undefined | null): string {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

export type FileCategory =
  | 'image'
  | 'video'
  | 'document'
  | 'archive'
  | 'audio'
  | 'other';

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'ico']);
const VIDEO = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp']);
const DOCUMENT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'csv', 'rtf', 'odt', 'ods', 'odp']);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab']);
const AUDIO = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape', 'opus']);

export function categoryOf(fileName: string | undefined | null): FileCategory {
  const ext = extOf(fileName);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (DOCUMENT.has(ext)) return 'document';
  if (ARCHIVE.has(ext)) return 'archive';
  if (AUDIO.has(ext)) return 'audio';
  return 'other';
}

export function categoryLabel(c: FileCategory): string {
  switch (c) {
    case 'image': return '图片';
    case 'video': return '视频';
    case 'document': return '文档';
    case 'archive': return '压缩包';
    case 'audio': return '音频';
    case 'other': return '其他';
  }
}

/** 截断长路径为 "开头…结尾" 形式 */
export function truncatePath(p: string, max = 60): string {
  if (!p) return '';
  if (p.length <= max) return p;
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return p.slice(0, head) + '…' + p.slice(p.length - tail);
}
