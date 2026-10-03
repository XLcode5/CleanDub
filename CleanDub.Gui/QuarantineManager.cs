using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace CleanDub.Gui;

/// <summary>
/// 隔离区管理器 —— GUI 端直接执行移入/还原/永久删除。
/// manifest.json 与 ops.jsonl 格式与 dedup_core.ps1 完全一致，引擎与 GUI 双向兼容。
/// 安全约束：只允许处理扫描根目录内的文件；还原时拒绝隔离区外来源。
/// </summary>
public class QuarantineManager
{
    private readonly string _scanRoot;

    public QuarantineManager(string scanRoot)
    {
        _scanRoot = Path.GetFullPath(scanRoot.Trim().TrimEnd('\\', '/'));
    }

    public string QuarantineRoot => Path.Combine(_scanRoot, "_dedup_quarantine");

    // ==================== 移入隔离区 ====================

    /// <summary>把勾选的冗余文件移入隔离区（新建一个 session 目录，保留相对路径结构）。</summary>
    public QuarantineResult MoveToQuarantine(IEnumerable<DuplicateFile> files)
    {
        var result = new QuarantineResult();
        var session = Path.Combine(QuarantineRoot,
            $"{DateTime.Now:yyyyMMdd_HHmmss}-{Guid.NewGuid().ToString("N")[..6]}");
        var entries = new List<Dictionary<string, object>>();
        long bytes = 0;

        foreach (var f in files)
        {
            string full;
            try { full = Path.GetFullPath(f.FullPath); }
            catch { result.Failures.Add((f.FullPath, "路径无效")); continue; }

            if (!IsUnderRoot(full)) { result.Failures.Add((f.FullPath, "不在扫描根目录内，已拒绝")); continue; }
            if (!File.Exists(full)) { result.Failures.Add((f.FullPath, "文件不存在（可能已被处理）")); continue; }

            var rel = full[_scanRoot.Length..].TrimStart('\\', '/');
            if (rel.Length == 0) rel = Path.GetFileName(full);
            var dest = Path.Combine(session, rel);
            var final = UniquePath(dest);

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(final)!);
                try { File.Move(full, final); }
                catch { File.Copy(full, final, true); File.Delete(full); }
                entries.Add(new Dictionary<string, object>
                {
                    ["original"] = full,
                    ["stored"] = final,
                    ["size"] = f.Size,
                    ["movedAt"] = DateTime.Now.ToString("s")
                });
                bytes += f.Size;
                result.Moved++;
            }
            catch (Exception ex) { result.Failures.Add((f.FullPath, ex.Message)); }
        }

        if (entries.Count > 0)
        {
            WriteManifest(session, entries);
            CleaningLog.Append(_scanRoot, "quarantine",
                $"{result.Moved} 个文件移入隔离区（{FormatSize(bytes)}）", result.Moved, bytes);
        }
        result.Bytes = bytes;
        return result;
    }

    // ==================== 读取隔离区 ====================

    /// <summary>枚举所有隔离会话（新的在前），解析 manifest.json。</summary>
    public List<QuarantineSession> LoadSessions()
    {
        var list = new List<QuarantineSession>();
        try
        {
            if (!Directory.Exists(QuarantineRoot)) return list;
            foreach (var dir in Directory.EnumerateDirectories(QuarantineRoot))
            {
                var s = LoadSession(dir);
                if (s != null) list.Add(s);
            }
        }
        catch { }
        return list.OrderByDescending(s => s.CreatedAt).ToList();
    }

    private QuarantineSession? LoadSession(string dir)
    {
        try
        {
            var mf = Path.Combine(dir, "manifest.json");
            if (!File.Exists(mf)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(mf));
            var root = doc.RootElement;
            var s = new QuarantineSession
            {
                Name = Path.GetFileName(dir),
                Path = dir
            };
            if (root.TryGetProperty("createdAt", out var ca) && DateTime.TryParse(ca.GetString(), out var dt))
                s.CreatedAt = dt;
            if (root.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array)
            {
                foreach (var f in files.EnumerateArray())
                {
                    var e = new QuarantineEntry
                    {
                        Original = Str(f, "original"),
                        Stored = Str(f, "stored"),
                        Size = Num(f, "size")
                    };
                    if (DateTime.TryParse(Str(f, "movedAt"), out var mt)) e.MovedAt = mt;
                    // 跳过缺字段的无效条目
                    if (e.Stored.Length > 0) s.Files.Add(e);
                }
            }
            return s;
        }
        catch { return null; }
    }

    // ==================== 还原 ====================

    /// <summary>还原选中条目到原始路径；目标已存在时追加 .restored 后缀。</summary>
    public QuarantineResult Restore(QuarantineSession session, IEnumerable<QuarantineEntry> entries)
    {
        var result = new QuarantineResult();
        var remaining = new List<QuarantineEntry>(session.Files);

        foreach (var e in entries)
        {
            string storedFull;
            try { storedFull = Path.GetFullPath(e.Stored); }
            catch { result.Failures.Add((e.Original, "路径无效")); continue; }

            // 安全：来源必须在隔离区内
            if (!storedFull.StartsWith(Path.GetFullPath(session.Path) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase))
            { result.Failures.Add((e.Stored, "不在隔离区内，已拒绝还原")); continue; }
            if (!File.Exists(storedFull)) { result.Failures.Add((e.Original, "隔离区内文件已不存在")); continue; }

            var target = e.Original;
            if (File.Exists(target)) target += ".restored";

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                try { File.Move(storedFull, target); }
                catch { File.Copy(storedFull, target, true); File.Delete(storedFull); }
                result.Moved++;
                result.Bytes += e.Size;
                remaining.Remove(e);
            }
            catch (Exception ex) { result.Failures.Add((e.Original, ex.Message)); }
        }

        PersistAfterPartial(session, remaining);
        if (result.Moved > 0)
            CleaningLog.Append(_scanRoot, "restore",
                $"还原 {result.Moved} 个文件（{FormatSize(result.Bytes)}）", result.Moved, result.Bytes);
        return result;
    }

    // ==================== 永久删除 ====================

    /// <summary>永久删除选中条目（不可撤销，调用方必须已二次确认）。</summary>
    public QuarantineResult Delete(QuarantineSession session, IEnumerable<QuarantineEntry> entries)
    {
        var result = new QuarantineResult();
        var remaining = new List<QuarantineEntry>(session.Files);

        foreach (var e in entries)
        {
            string storedFull;
            try { storedFull = Path.GetFullPath(e.Stored); }
            catch { result.Failures.Add((e.Original, "路径无效")); continue; }
            if (!storedFull.StartsWith(Path.GetFullPath(session.Path) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase))
            { result.Failures.Add((e.Stored, "不在隔离区内，已拒绝删除")); continue; }

            try
            {
                if (File.Exists(storedFull)) File.Delete(storedFull);
                result.Moved++;
                result.Bytes += e.Size;
                remaining.Remove(e);
            }
            catch (Exception ex) { result.Failures.Add((e.Original, ex.Message)); }
        }

        PersistAfterPartial(session, remaining);
        if (result.Moved > 0)
            CleaningLog.Append(_scanRoot, "delete",
                $"永久删除 {result.Moved} 个文件（{FormatSize(result.Bytes)}）", result.Moved, result.Bytes);
        return result;
    }

    /// <summary>清空整个隔离区。</summary>
    public QuarantineResult PurgeAll()
    {
        var result = new QuarantineResult();
        try
        {
            if (!Directory.Exists(QuarantineRoot)) return result;
            foreach (var dir in Directory.EnumerateDirectories(QuarantineRoot))
            {
                try
                {
                    var files = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).ToList();
                    long bytes = files.Sum(f => new FileInfo(f).Length);
                    Directory.Delete(dir, true);
                    result.Moved += files.Count;
                    result.Bytes += bytes;
                }
                catch (Exception ex) { result.Failures.Add((dir, ex.Message)); }
            }
            if (result.Moved > 0)
                CleaningLog.Append(_scanRoot, "purge",
                    $"清空隔离区：{result.Moved} 个文件（{FormatSize(result.Bytes)}）", result.Moved, result.Bytes);
        }
        catch { }
        return result;
    }

    // ==================== 内部 ====================

    /// <summary>部分处理后回写 manifest；会话空了就删掉整个 session 目录。</summary>
    private void PersistAfterPartial(QuarantineSession session, List<QuarantineEntry> remaining)
    {
        try
        {
            if (remaining.Count == 0)
            {
                if (Directory.Exists(session.Path)) Directory.Delete(session.Path, true);
                return;
            }
            WriteManifest(session.Path, remaining.Select(e => new Dictionary<string, object>
            {
                ["original"] = e.Original,
                ["stored"] = e.Stored,
                ["size"] = e.Size,
                ["movedAt"] = e.MovedAt.ToString("s")
            }).ToList());
        }
        catch { }
    }

    private void WriteManifest(string session, List<Dictionary<string, object>> entries)
    {
        var manifest = new Dictionary<string, object>
        {
            ["scanRoot"] = _scanRoot,
            ["createdAt"] = DateTime.Now.ToString("s"),
            ["files"] = entries
        };
        File.WriteAllText(Path.Combine(session, "manifest.json"),
            JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = false }),
            new System.Text.UTF8Encoding(false));
    }

    private bool IsUnderRoot(string fullPath) =>
        fullPath.StartsWith(_scanRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private static string UniquePath(string dest)
    {
        var final = dest;
        for (int i = 1; File.Exists(final); i++) final = dest + "." + i;
        return final;
    }

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static long Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;

    private static string FormatSize(long bytes)
    {
        if (bytes >= 1073741824) return $"{bytes / 1073741824.0:F2} GB";
        if (bytes >= 1048576) return $"{bytes / 1048576.0:F1} MB";
        if (bytes >= 1024) return $"{bytes / 1024.0:F1} KB";
        return $"{bytes} B";
    }
}

/// <summary>隔离区操作结果（Moved 兼作还原/删除的成功计数）</summary>
public class QuarantineResult
{
    public int Moved { get; set; }
    public long Bytes { get; set; }
    public List<(string Path, string Reason)> Failures { get; } = new();
}
