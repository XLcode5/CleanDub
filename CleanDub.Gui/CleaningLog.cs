using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace CleanDub.Gui;

/// <summary>
/// ops.jsonl 操作日志读写。格式与 dedup_core.ps1 完全一致（每行一个 JSON 对象），
/// 引擎与 GUI 写入的记录互相可见。
/// </summary>
public static class CleaningLog
{
    public static string LogFileFor(string root) =>
        Path.Combine(root, "_dedup_logs", "ops.jsonl");

    /// <summary>追加一条操作日志。失败静默（日志不应阻塞业务）。</summary>
    public static void Append(string root, string op, string detail, int files = 0, long bytes = 0, long elapsedMs = 0)
    {
        try
        {
            var dir = Path.Combine(root, "_dedup_logs");
            Directory.CreateDirectory(dir);
            var entry = new Dictionary<string, object?>
            {
                ["op"] = op,
                ["ts"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss"),
                // opId 形如 20261002_224415-a1b2c3，与引擎 session 目录命名一致
                ["opId"] = $"{DateTime.Now:yyyyMMdd_HHmmss}-{Guid.NewGuid().ToString("N")[..6]}",
                ["root"] = root,
                ["detail"] = detail
            };
            if (files > 0) entry["totalVictims"] = files;
            if (bytes > 0) entry["realBytes"] = bytes;
            if (elapsedMs > 0) entry["elapsedMs"] = elapsedMs;
            File.AppendAllText(LogFileFor(root),
                JsonSerializer.Serialize(entry) + Environment.NewLine,
                new System.Text.UTF8Encoding(false));
        }
        catch { }
    }

    /// <summary>读取日志（新的在前），limit 条封顶。</summary>
    public static List<HistoryItem> Read(string root, int limit = 300)
    {
        var list = new List<HistoryItem>();
        var file = LogFileFor(root);
        try
        {
            if (!File.Exists(file)) return list;
            foreach (var line in File.ReadLines(file).Reverse())
            {
                if (list.Count >= limit) break;
                if (string.IsNullOrWhiteSpace(line)) continue;
                var item = Parse(line, root);
                if (item != null) list.Add(item);
            }
        }
        catch { }
        return list;
    }

    private static HistoryItem? Parse(string line, string root)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var r = doc.RootElement;
            var item = new HistoryItem
            {
                Op = GetStr(r, "op"),
                Detail = GetStr(r, "detail"),
                OpId = GetStr(r, "opId"),
                Root = GetStr(r, "root").Length > 0 ? GetStr(r, "root") : root
            };
            if (DateTime.TryParse(GetStr(r, "ts"), out var ts)) item.Timestamp = ts;
            item.Bytes = GetLong(r, "realBytes");
            if (item.Bytes == 0) item.Bytes = GetLong(r, "nominalBytes");
            item.Files = (int)GetLong(r, "totalVictims");
            item.ElapsedMs = GetLong(r, "elapsedMs");
            return item;
        }
        catch { return null; }
    }

    private static string GetStr(JsonElement r, string name) =>
        r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static long GetLong(JsonElement r, string name) =>
        r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
}
