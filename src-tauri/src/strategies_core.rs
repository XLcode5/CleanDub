// CleanDub v1.2.0 — 保留策略核心（对齐 dedup_core.ps1 Get-Keeper2 / db.js pickKeeper）
// 安全关键模块：策略选错会导致误删用户文件，故由维护者手写、逐断言对齐 JS 版。
use serde::{Deserialize, Serialize};

/// 候选文件（db scanned_files 行的最小投影）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeeperCandidate {
    pub id: i64,
    pub canonical_path: String,
    pub file_name: String,
    pub modified_at: String, // ISO 8601
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RetainStrategy {
    #[serde(rename = "Cleanest")]
    Cleanest,
    #[serde(rename = "Newest")]
    Newest,
    #[serde(rename = "Original")]
    Original,
    #[serde(rename = "Highest")]
    Highest,
    #[serde(rename = "ShortestName")]
    ShortestName,
    #[serde(rename = "LongestName")]
    LongestName,
}

impl RetainStrategy {
    pub fn parse(s: &str) -> RetainStrategy {
        match s {
            "Newest" => RetainStrategy::Newest,
            "Original" => RetainStrategy::Original,
            "Highest" => RetainStrategy::Highest,
            "ShortestName" => RetainStrategy::ShortestName,
            "LongestName" => RetainStrategy::LongestName,
            _ => RetainStrategy::Cleanest, // 缺省（对齐 JS 白名单 fallback）
        }
    }
}

/// basename 后缀标记信息（对齐 suffixMarkerInfo）：
/// - base = 文件名去扩展名（最后一个 '.' 及之后）
/// - count = base 中 "(N)" 模式出现次数
/// - max_n = base 尾部 "(N)" 的数字（无尾部标记 = 0）
/// - has_trailing = base 是否以 "(N)"（允许前后空白）结尾
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct SuffixMarkerInfo {
    count: usize,
    max_n: i64,
    has_trailing: bool,
}

fn suffix_marker_info(file_name: &str) -> SuffixMarkerInfo {
    let name = file_name;
    let base = match name.rfind('.') {
        Some(0) | None => name,
        Some(pos) => &name[..pos],
    };
    let mut info = SuffixMarkerInfo::default();
    // 统计 "(数字)" 出现次数
    let bytes = base.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'(' {
            let mut j = i + 1;
            let mut digits = String::new();
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                digits.push(bytes[j] as char);
                j += 1;
            }
            if j > i + 1 && j < bytes.len() && bytes[j] == b')' {
                info.count += 1;
                // 尾部标记：')' 后只允许空白到结尾
                let tail = &base[j + 1..];
                if tail.trim().is_empty() {
                    info.max_n = digits.parse::<i64>().unwrap_or(0);
                    info.has_trailing = true;
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    info
}

/// 解析 modified_at（ISO 8601）为 epoch 毫秒；失败返回 0（对齐 mtimeOf）
fn mtime_of(s: &str) -> i64 {
    // 常见格式："2026-10-11T23:45:12.345Z" / "2026-10-11T23:45:12"
    // 手写最小解析避免引入 chrono 依赖（性能：每文件一次）
    let b = s.as_bytes();
    if b.len() < 19 {
        return 0;
    }
    let num = |r: std::ops::Range<usize>| -> i64 {
        b.get(r).map(|x| String::from_utf8_lossy(x).parse::<i64>().unwrap_or(0)).unwrap_or(0)
    };
    let (y, mo, d) = (num(0..4), num(5..7), num(8..10));
    let (h, mi, s) = (num(11..13), num(14..16), num(17..19));
    if y == 0 || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    // 简化儒略日（民用算法，足够排序用；不处理闰秒）
    let days = days_from_civil(y, mo, d);
    let secs = days * 86400 + h * 3600 + mi * 60 + s;
    secs * 1000
}

/// Howard Hinnant 的 days_from_civil 算法（公历）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 从一组重复文件中按策略选出 keeper（对齐 pickKeeper）。
/// 空组返回 None；单文件直接返回。
pub fn pick_keeper(files: &[KeeperCandidate], strategy: RetainStrategy) -> Option<KeeperCandidate> {
    if files.is_empty() {
        return None;
    }
    if files.len() == 1 {
        return Some(files[0].clone());
    }

    #[derive(Clone)]
    struct E {
        f: KeeperCandidate,
        mi: SuffixMarkerInfo,
        mt: i64,
    }
    let enriched: Vec<E> = files
        .iter()
        .map(|f| E {
            mi: suffix_marker_info(&f.file_name),
            mt: mtime_of(&f.modified_at),
            f: f.clone(),
        })
        .collect();

    match strategy {
        RetainStrategy::Newest => {
            let mut v = enriched;
            v.sort_by(|a, b| b.mt.cmp(&a.mt));
            v.into_iter().next().map(|e| e.f)
        }
        RetainStrategy::Original => {
            let plain: Vec<E> = enriched.iter().filter(|e| !e.mi.has_trailing).cloned().collect();
            let mut v = if !plain.is_empty() { plain } else { enriched };
            v.sort_by(|a, b| b.mt.cmp(&a.mt));
            v.into_iter().next().map(|e| e.f)
        }
        RetainStrategy::Highest => {
            let mut v = enriched;
            v.sort_by(|a, b| b.mi.max_n.cmp(&a.mi.max_n).then(b.mt.cmp(&a.mt)));
            v.into_iter().next().map(|e| e.f)
        }
        RetainStrategy::ShortestName => {
            let name_len = |e: &E| e.f.file_name.chars().count() as i64;
            let mut v = enriched;
            v.sort_by(|a, b| name_len(a).cmp(&name_len(b)).then(b.mt.cmp(&a.mt)));
            v.into_iter().next().map(|e| e.f)
        }
        RetainStrategy::LongestName => {
            let name_len = |e: &E| e.f.file_name.chars().count() as i64;
            let mut v = enriched;
            v.sort_by(|a, b| name_len(b).cmp(&name_len(a)).then(b.mt.cmp(&a.mt)));
            v.into_iter().next().map(|e| e.f)
        }
        RetainStrategy::Cleanest => {
            // (N) 个数最少 → mtime 最新 → 路径最短
            let path_len = |e: &E| e.f.canonical_path.chars().count() as i64;
            let mut v = enriched;
            v.sort_by(|a, b| {
                a.mi.count
                    .cmp(&b.mi.count)
                    .then(b.mt.cmp(&a.mt))
                    .then(path_len(a).cmp(&path_len(b)))
            });
            v.into_iter().next().map(|e| e.f)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: i64, path: &str, mtime: &str) -> KeeperCandidate {
        let name = path.rsplit(['\\', '/']).next().unwrap_or(path).to_string();
        KeeperCandidate { id, canonical_path: path.to_string(), file_name: name, modified_at: mtime.to_string() }
    }

    #[test]
    fn cleanest_prefers_no_suffix() {
        let files = vec![
            cand(1, "C:/a/report (1).txt", "2026-01-01T00:00:00"),
            cand(2, "C:/a/report.txt", "2025-06-01T00:00:00"),
            cand(3, "C:/a/report (2).txt", "2026-01-01T00:00:00"),
        ];
        let k = pick_keeper(&files, RetainStrategy::Cleanest).unwrap();
        assert_eq!(k.id, 2, "无后缀者 count 最少应胜出");
    }

    #[test]
    fn newest_picks_latest_mtime() {
        let files = vec![
            cand(1, "C:/a/x.txt", "2026-01-01T00:00:00"),
            cand(2, "C:/a/y.txt", "2025-01-01T00:00:00"),
        ];
        let k = pick_keeper(&files, RetainStrategy::Newest).unwrap();
        assert_eq!(k.id, 1);
    }

    #[test]
    fn original_avoids_trailing_marker() {
        let files = vec![
            cand(1, "C:/a/doc (1).txt", "2026-05-01T00:00:00"),
            cand(2, "C:/a/doc.txt", "2025-05-01T00:00:00"),
        ];
        let k = pick_keeper(&files, RetainStrategy::Original).unwrap();
        assert_eq!(k.id, 2, "无尾部标记优先（即使更旧）");
        // 全带后缀退回 Newest
        let files2 = vec![
            cand(3, "C:/a/doc (2).txt", "2026-01-01T00:00:00"),
            cand(4, "C:/a/doc (1).txt", "2025-01-01T00:00:00"),
        ];
        assert_eq!(pick_keeper(&files2, RetainStrategy::Original).unwrap().id, 3);
    }

    #[test]
    fn highest_picks_max_suffix_n() {
        let files = vec![
            cand(1, "C:/a/file (1).txt", "2026-01-01T00:00:00"),
            cand(2, "C:/a/file (9).txt", "2025-01-01T00:00:00"),
        ];
        let k = pick_keeper(&files, RetainStrategy::Highest).unwrap();
        assert_eq!(k.id, 2, "尾部 (9) > (1)");
    }

    #[test]
    fn name_length_strategies() {
        let files = vec![
            cand(1, "C:/a/aaaa.txt", "2026-01-01T00:00:00"),
            cand(2, "C:/a/b.txt", "2025-01-01T00:00:00"),
        ];
        assert_eq!(pick_keeper(&files, RetainStrategy::ShortestName).unwrap().id, 2);
        assert_eq!(pick_keeper(&files, RetainStrategy::LongestName).unwrap().id, 1);
    }

    #[test]
    fn suffix_marker_counts() {
        let mi = suffix_marker_info("photo (1) (2).jpg");
        assert_eq!(mi.count, 2);
        assert_eq!(mi.max_n, 2);
        assert!(mi.has_trailing);
        let mi2 = suffix_marker_info("report.txt");
        assert_eq!(mi2.count, 0);
        assert!(!mi2.has_trailing);
        let mi3 = suffix_marker_info("a (3) final.txt");
        assert_eq!(mi3.count, 1);
        assert!(!mi3.has_trailing, "尾部非 (N) 结尾");
        assert_eq!(mi3.max_n, 0);
    }

    #[test]
    fn empty_and_single() {
        assert!(pick_keeper(&[], RetainStrategy::Cleanest).is_none());
        let one = vec![cand(7, "C:/only.txt", "2026-01-01T00:00:00")];
        assert_eq!(pick_keeper(&one, RetainStrategy::Newest).unwrap().id, 7);
    }
}
