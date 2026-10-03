using System;
using System.Collections.Generic;
using System.Linq;

namespace CleanDub.Gui;

/// <summary>扫描阶段</summary>
public enum ScanPhase
{
    Idle,
    Indexing,
    SizeGrouping,
    PreHashing,
    FullHashing,
    Completed,
    Canceled,
    Error
}

/// <summary>保留策略</summary>
public enum RetentionStrategy
{
    Cleanest,
    Newest,
    Original,
    Highest
}

/// <summary>校验级别</summary>
public enum VerifyLevel
{
    Full,
    Head,
    Name,
    Size
}

/// <summary>操作类型（日志）</summary>
public enum OpType
{
    Scan,
    Quarantine,
    QuarantineRestore,
    QuarantinePurge,
    PurgePermanent
}

/// <summary>扫描进度快照</summary>
public class ScanProgress
{
    public ScanPhase Phase { get; set; } = ScanPhase.Idle;
    public int ScannedFiles { get; set; }
    public int TotalFiles { get; set; }
    public int Candidates { get; set; }
    public int PreSurvivors { get; set; }
    public int FullHashed { get; set; }
    public int TotalGroups { get; set; }
    public int TotalVictims { get; set; }
    public long RealBytes { get; set; }
    public long ElapsedMs { get; set; }
    public string? Error { get; set; }

    public double ProgressPercent => TotalFiles > 0
        ? Math.Min(100.0, (double)ScannedFiles / TotalFiles * 100)
        : 0;

    public string PhaseLabel => Phase switch
    {
        ScanPhase.Idle => "就绪",
        ScanPhase.Indexing => "正在索引文件…",
        ScanPhase.SizeGrouping => "按大小分组…",
        ScanPhase.PreHashing => "头部预哈希…",
        ScanPhase.FullHashing => "全量 SHA-256…",
        ScanPhase.Completed => "扫描完成",
        ScanPhase.Canceled => "已取消",
        ScanPhase.Error => "出错",
        _ => ""
    };
}

/// <summary>重复组</summary>
public class DuplicateGroup
{
    public string Directory { get; set; } = "";
    public int FileCount { get; set; }
    public long ReclaimableBytes { get; set; }
    public string KeeperPath { get; set; } = "";
    public List<DuplicateFile> Victims { get; set; } = new();
    public bool IsHardLinked { get; set; }
    public bool Expanded { get; set; }          // GUI 展开/折叠状态

    public string ReclaimableLabel
    {
        get
        {
            if (ReclaimableBytes >= 1073741824)
                return $"{ReclaimableBytes / 1073741824.0:F2} GB";
            if (ReclaimableBytes >= 1048576)
                return $"{ReclaimableBytes / 1048576.0:F1} MB";
            if (ReclaimableBytes >= 1024)
                return $"{ReclaimableBytes / 1024.0:F1} KB";
            return $"{ReclaimableBytes} B";
        }
    }
}

/// <summary>单个重复文件</summary>
public class DuplicateFile
{
    public string FullPath { get; set; } = "";
    public string FileName => System.IO.Path.GetFileName(FullPath);
    public long Size { get; set; }
    public DateTime LastWriteTime { get; set; }
    public string Hash { get; set; } = "";
    public bool IsKeeper { get; set; }
    public bool Selected { get; set; } = true;
    public int ParenthesizedCount { get; set; }

    public string SizeLabel
    {
        get
        {
            if (Size >= 1073741824) return $"{Size / 1073741824.0:F2} GB";
            if (Size >= 1048576) return $"{Size / 1048576.0:F1} MB";
            if (Size >= 1024) return $"{Size / 1024.0:F1} KB";
            return $"{Size} B";
        }
    }
}

/// <summary>完整扫描结果</summary>
public class ScanResult
{
    public List<DuplicateGroup> Groups { get; set; } = new();
    public int TotalGroups { get; set; }
    public int TotalVictims { get; set; }
    public long SurfaceBytes { get; set; }
    public long RealBytes { get; set; }
    public int HardLinkGroups { get; set; }
    public long ElapsedMs { get; set; }
    public int TotalFiles { get; set; }
    public int Candidates { get; set; }
    public int PreSurvivors { get; set; }
    public int FullHashed { get; set; }
    public string VerifyLabel { get; set; } = "Full";
    public int HeadKB { get; set; } = 32;

    public string SurfaceLabel
    {
        get
        {
            if (SurfaceBytes >= 1073741824) return $"{SurfaceBytes / 1073741824.0:F2} GB";
            if (SurfaceBytes >= 1048576) return $"{SurfaceBytes / 1048576.0:F1} MB";
            return $"{SurfaceBytes / 1024.0:F1} KB";
        }
    }

    public string RealLabel
    {
        get
        {
            if (RealBytes >= 1073741824) return $"{RealBytes / 1073741824.0:F2} GB";
            if (RealBytes >= 1048576) return $"{RealBytes / 1048576.0:F1} MB";
            return $"{RealBytes / 1024.0:F1} KB";
        }
    }

    public string ElapsedLabel
    {
        get
        {
            if (ElapsedMs >= 60000) return $"{ElapsedMs / 60000}m {ElapsedMs % 60000 / 1000}s";
            if (ElapsedMs >= 1000) return $"{ElapsedMs / 1000.0:F1}s";
            return $"{ElapsedMs}ms";
        }
    }
}

/// <summary>操作日志条目</summary>
public class OpLogEntry
{
    public OpType Op { get; set; }
    public DateTime Timestamp { get; set; }
    public int Files { get; set; }
    public long Bytes { get; set; }
    public string Session { get; set; } = "";
    public string Detail { get; set; } = "";
}

/// <summary>历史页展示条目（从 ops.jsonl 解析）</summary>
public class HistoryItem
{
    public string Op { get; set; } = "";          // scan / quarantine / restore / purge / delete
    public DateTime Timestamp { get; set; }
    public string Detail { get; set; } = "";
    public string OpId { get; set; } = "";
    public string Root { get; set; } = "";
    public long Bytes { get; set; }
    public int Files { get; set; }
    public long ElapsedMs { get; set; }

    public string LogDir => Root.Length > 0
        ? System.IO.Path.Combine(Root, "_dedup_logs", OpId)
        : "";

    public string OpLabel => Op switch
    {
        "scan" => "扫描",
        "quarantine" => "移入隔离区",
        "restore" => "从隔离区还原",
        "purge" => "清空隔离区",
        "delete" => "永久删除",
        _ => Op
    };

    /// <summary>相对时间：刚刚 / N 分钟前 / HH:mm / MM-dd</summary>
    public string RelativeTime
    {
        get
        {
            var span = DateTime.Now - Timestamp;
            if (span.TotalMinutes < 1) return "刚刚";
            if (span.TotalHours < 1) return $"{(int)span.TotalMinutes} 分钟前";
            if (Timestamp.Date == DateTime.Today) return Timestamp.ToString("HH:mm");
            if (Timestamp.Year == DateTime.Today.Year) return Timestamp.ToString("MM-dd HH:mm");
            return Timestamp.ToString("yyyy-MM-dd");
        }
    }

    public string BytesLabel
    {
        get
        {
            if (Bytes >= 1073741824) return $"{Bytes / 1073741824.0:F2} GB";
            if (Bytes >= 1048576) return $"{Bytes / 1048576.0:F1} MB";
            if (Bytes >= 1024) return $"{Bytes / 1024.0:F1} KB";
            return Bytes > 0 ? $"{Bytes} B" : "";
        }
    }
}

/// <summary>隔离区单个文件条目（manifest.json 中 files 数组的元素）</summary>
public class QuarantineEntry
{
    public string Original { get; set; } = "";   // 原始完整路径
    public string Stored { get; set; } = "";     // 隔离区内完整路径
    public long Size { get; set; }
    public DateTime MovedAt { get; set; }
    public bool Selected { get; set; }           // GUI 勾选状态

    public string FileName => System.IO.Path.GetFileName(Original);

    public string SizeLabel
    {
        get
        {
            if (Size >= 1073741824) return $"{Size / 1073741824.0:F2} GB";
            if (Size >= 1048576) return $"{Size / 1048576.0:F1} MB";
            if (Size >= 1024) return $"{Size / 1024.0:F1} KB";
            return $"{Size} B";
        }
    }
}

/// <summary>隔离区会话（一次「移入隔离区」操作对应一个目录）</summary>
public class QuarantineSession
{
    public string Name { get; set; } = "";       // 目录名，如 20261002_104259-94511a
    public string Path { get; set; } = "";       // 完整路径
    public DateTime CreatedAt { get; set; }
    public List<QuarantineEntry> Files { get; set; } = new();
    public bool Expanded { get; set; } = true;

    public long TotalBytes => Files.Sum(f => f.Size);
    public int SelectedCount => Files.Count(f => f.Selected);

    public string TotalLabel
    {
        get
        {
            var b = TotalBytes;
            if (b >= 1073741824) return $"{b / 1073741824.0:F2} GB";
            if (b >= 1048576) return $"{b / 1048576.0:F1} MB";
            if (b >= 1024) return $"{b / 1024.0:F1} KB";
            return $"{b} B";
        }
    }

    public string CreatedLabel => CreatedAt == default
        ? Name
        : CreatedAt.ToString("yyyy-MM-dd HH:mm:ss");
}

/// <summary>应用设置</summary>
public class AppSettings
{
    public string DefaultPath { get; set; } = "";
    public RetentionStrategy Strategy { get; set; } = RetentionStrategy.Cleanest;
    public VerifyLevel Verify { get; set; } = VerifyLevel.Full;
    public bool DetectLinks { get; set; } = true;
    public bool Recurse { get; set; } = true;
    public bool DarkTheme { get; set; } = true;
    public int HeadKB { get; set; } = 32;
}
