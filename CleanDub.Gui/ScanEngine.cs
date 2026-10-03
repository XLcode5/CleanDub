using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace CleanDub.Gui;

/// <summary>PowerShell 引擎封装 —— 负责与 dedup_core.ps1 / dedup.ps1 通信</summary>
public class ScanEngine
{
    private readonly string _appDir;
    private Process? _process;
    private CancellationTokenSource? _cts;

    public ScanEngine()
    {
        _appDir = AppDomain.CurrentDomain.BaseDirectory;
        // 开发态：exe 在 bin/Debug/net8.0-windows 下，回退到项目根目录找脚本
        if (!File.Exists(Path.Combine(_appDir, "dedup_core.ps1")))
            _appDir = Path.GetFullPath(Path.Combine(_appDir, "..", "..", "..", ".."));
    }

    public string EngineDir => _appDir;

    /// <summary>本次扫描的进度文件路径（引擎每次覆盖写入最新状态，GUI 轮询读取）。</summary>
    public string? CurrentProgressFile { get; private set; }

    private static string StrategyArg(RetentionStrategy s) => s switch
    {
        RetentionStrategy.Newest => "Newest",
        RetentionStrategy.Original => "Original",
        RetentionStrategy.Highest => "Highest",
        _ => "Cleanest"
    };

    private static string VerifyArg(VerifyLevel v) => v switch
    {
        VerifyLevel.Head => "Head",
        VerifyLevel.Name => "Name",
        VerifyLevel.Size => "Size",
        _ => "Full"
    };

    /// <summary>运行扫描（DryRun），解析进度与结果明细</summary>
    public async Task<ScanResult> ScanAsync(
        string path,
        RetentionStrategy strategy,
        VerifyLevel verify,
        bool detectLinks,
        int headKB,
        IProgress<ScanProgress>? progress = null,
        CancellationToken ct = default,
        bool recurse = true)
    {
        var result = new ScanResult { VerifyLabel = VerifyArg(verify), HeadKB = headKB };
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);

        CurrentProgressFile = Path.Combine(Path.GetTempPath(), $"cleandub-progress-{Guid.NewGuid():N}.json");
        var args = $"-NoProfile -ExecutionPolicy Bypass -File \"{Path.Combine(_appDir, "dedup.ps1")}\" " +
                   $"-Path \"{path}\" -DryRun -Strategy {StrategyArg(strategy)} -Verify {VerifyArg(verify)} " +
                   $"-HeadKB {headKB} -MaxPrint 500 -ProgressFile \"{CurrentProgressFile}\"";
        if (!detectLinks) args += " -NoLinkCheck";
        if (!recurse) args += " -NoRecurse";

        try
        {
            await RunProcessAsync(args, line => ParseProgressLine(line, result, progress), _cts.Token,
                () =>
                {
                    progress?.Report(new ScanProgress { Phase = ScanPhase.Canceled });
                });
        }
        finally
        {
            try { if (CurrentProgressFile != null && File.Exists(CurrentProgressFile)) File.Delete(CurrentProgressFile); }
            catch { }
        }

        if (_cts.IsCancellationRequested)
            return result;

        progress?.Report(new ScanProgress
        {
            Phase = ScanPhase.Completed,
            TotalGroups = result.TotalGroups,
            TotalVictims = result.TotalVictims,
            RealBytes = result.RealBytes,
            TotalFiles = result.TotalFiles,
            Candidates = result.Candidates,
            PreSurvivors = result.PreSurvivors,
            FullHashed = result.FullHashed,
            ElapsedMs = result.ElapsedMs
        });
        return result;
    }

    /// <summary>执行清理动作（隔离区 / 永久删除）。需要 -Yes 跳过交互确认。</summary>
    public async Task<(int ExitCode, string Output)> RunActionAsync(
        string path, string action,
        RetentionStrategy strategy, VerifyLevel verify,
        bool detectLinks, bool recurse, int headKB,
        Action<string>? onLine = null, CancellationToken ct = default)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var args = $"-NoProfile -ExecutionPolicy Bypass -File \"{Path.Combine(_appDir, "dedup.ps1")}\" " +
                   $"-Path \"{path}\" -Action {action} -Yes -Strategy {StrategyArg(strategy)} " +
                   $"-Verify {VerifyArg(verify)} -HeadKB {headKB} -MaxPrint 0";
        if (!detectLinks) args += " -NoLinkCheck";
        if (!recurse) args += " -NoRecurse";

        var lines = new List<string>();
        int code = await RunProcessAsync(args, line => { lines.Add(line); onLine?.Invoke(line); }, _cts.Token, null);
        return (code, string.Join(Environment.NewLine, lines));
    }

    /// <summary>导出 CSV 计划文件</summary>
    public async Task<string?> ExportCsvAsync(string path, string outputPath,
        RetentionStrategy strategy, VerifyLevel verify, bool detectLinks, bool recurse, int headKB)
    {
        var args = $"-NoProfile -ExecutionPolicy Bypass -File \"{Path.Combine(_appDir, "dedup.ps1")}\" " +
                   $"-Path \"{path}\" -DryRun -ExportCsv \"{outputPath}\" -Strategy {StrategyArg(strategy)} " +
                   $"-Verify {VerifyArg(verify)} -HeadKB {headKB} -MaxPrint 0";
        if (!detectLinks) args += " -NoLinkCheck";
        if (!recurse) args += " -NoRecurse";

        await RunProcessAsync(args, null, CancellationToken.None, null);
        return File.Exists(outputPath) ? outputPath : null;
    }

    /// <summary>停止当前运行的进程</summary>
    public void Stop()
    {
        try { _cts?.Cancel(); } catch { }
        try { if (_process is { HasExited: false }) _process.Kill(true); } catch { }
    }

    // ==================== 进程执行 ====================
    private async Task<int> RunProcessAsync(string args, Action<string>? onLine,
        CancellationToken ct, Action? onCanceled)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = args,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8
        };

        using (_process = new Process { StartInfo = psi, EnableRaisingEvents = true })
        {
            _process.OutputDataReceived += (s, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data)) onLine?.Invoke(e.Data);
            };

            try
            {
                _process.Start();
                _process.BeginOutputReadLine();
                var errorTask = _process.StandardError.ReadToEndAsync();
                await _process.WaitForExitAsync(ct);
                var error = await errorTask;

                if (_process.ExitCode != 0 && !string.IsNullOrWhiteSpace(error))
                    onLine?.Invoke("[错误] " + error.Trim());

                return _process.ExitCode;
            }
            catch (OperationCanceledException)
            {
                try { if (!_process.HasExited) _process.Kill(true); } catch { }
                onCanceled?.Invoke();
                return -1;
            }
        }
    }

    // ==================== 输出解析 ====================
    private DuplicateGroup? _currentGroup;

    private void ParseProgressLine(string line, ScanResult result, IProgress<ScanProgress>? progress)
    {
        // 组明细：[1] <目录>
        var gm = Regex.Match(line, @"^\[(\d+)\]\s+(.+)$");
        if (gm.Success)
        {
            _currentGroup = new DuplicateGroup { Directory = gm.Groups[2].Value.Trim() };
            result.Groups.Add(_currentGroup);
            return;
        }

        // 保留行 / 删除行：    保留  <name>   <mtime>   <size>
        var fm = Regex.Match(line, @"^\s+(保留|删除)\s{1,2}(.+?)\s{2,}([\d\-: ]+)\s{2,}([\d.,]+\s*[BKMG]B?)$");
        if (fm.Success && _currentGroup != null)
        {
            bool isKeeper = fm.Groups[1].Value == "保留";
            var file = new DuplicateFile
            {
                FullPath = Path.Combine(_currentGroup.Directory, fm.Groups[2].Value.Trim()),
                Size = ParseSizeLabel(fm.Groups[4].Value),
                IsKeeper = isKeeper,
                Selected = !isKeeper
            };
            if (DateTime.TryParse(fm.Groups[3].Value.Trim(), out var mt))
                file.LastWriteTime = mt;

            if (isKeeper)
            {
                _currentGroup.KeeperPath = file.FullPath;
            }
            else
            {
                _currentGroup.Victims.Add(file);
                if (!line.Contains("硬链接"))
                    _currentGroup.ReclaimableBytes += file.Size;
                else
                    _currentGroup.IsHardLinked = true;
            }
            _currentGroup.FileCount = _currentGroup.Victims.Count + (_currentGroup.KeeperPath.Length > 0 ? 1 : 0);
            return;
        }

        if (line.Contains("表面可释放"))
        {
            TryParseBytes(line, "表面可释放", out var b);
            result.SurfaceBytes = b;
        }
        else if (line.Contains("真实可释放"))
        {
            TryParseBytes(line, "真实可释放", out var b);
            result.RealBytes = b;
        }
        else if (line.Contains("发现") && line.Contains("组重复"))
        {
            TryParseInt(line, "发现", out var groups);
            result.TotalGroups = groups;
            TryParseInt(line, "待处理", out var victims);
            result.TotalVictims = victims;
            TryParseBytes(line, "可释放", out var bytes);
            if (bytes > 0) result.RealBytes = bytes;
        }
        else if (line.Contains("扫描文件"))
        {
            TryParseInt(line, "扫描文件", out var total);
            result.TotalFiles = total;
        }
        else if (line.Contains("候选"))
        {
            TryParseInt(line, "候选", out var cand);
            result.Candidates = cand;
        }
        else if (line.Contains("prehash") && line.Contains("幸存"))
        {
            TryParseInt(line, "幸存", out var pre);
            result.PreSurvivors = pre;
        }
        else if (line.Contains("全量") && line.Contains("读取"))
        {
            TryParseInt(line, "读取", out var full);
            result.FullHashed = full;
        }
        else if (line.Contains("耗时"))
        {
            TryParseMs(line, out var ms);
            result.ElapsedMs = ms;
            progress?.Report(new ScanProgress
            {
                Phase = ScanPhase.Completed,
                TotalFiles = result.TotalFiles,
                ScannedFiles = result.TotalFiles,
                Candidates = result.Candidates,
                PreSurvivors = result.PreSurvivors,
                FullHashed = result.FullHashed,
                TotalGroups = result.TotalGroups,
                TotalVictims = result.TotalVictims,
                RealBytes = result.RealBytes,
                ElapsedMs = ms
            });
        }
        else if (line.Contains("索引") || line.Contains("扫描"))
        {
            progress?.Report(new ScanProgress { Phase = ScanPhase.Indexing, TotalFiles = result.TotalFiles });
        }
    }

    /// <summary>解析 "10.5 MB" / "512 KB" 之类的大小标签</summary>
    public static long ParseSizeLabel(string label)
    {
        var m = Regex.Match(label.Trim(), @"([\d.,]+)\s*([BKMG])?B?", RegexOptions.IgnoreCase);
        if (!m.Success) return 0;
        if (!double.TryParse(m.Groups[1].Value.Replace(",", ""), out var num)) return 0;
        return m.Groups[2].Value.ToUpperInvariant() switch
        {
            "G" => (long)(num * 1073741824),
            "M" => (long)(num * 1048576),
            "K" => (long)(num * 1024),
            _ => (long)num
        };
    }

    private static void TryParseInt(string line, string prefix, out int value)
    {
        value = 0;
        var idx = line.IndexOf(prefix, StringComparison.Ordinal);
        if (idx < 0) return;
        var sub = line[(idx + prefix.Length)..].Trim().TrimStart(':', '：', ' ', '\t');
        var numStr = "";
        foreach (var c in sub)
        {
            if (char.IsDigit(c) || c == ',') numStr += c;
            else if (numStr.Length > 0) break;
        }
        int.TryParse(numStr.Replace(",", ""), out value);
    }

    private static void TryParseBytes(string line, string key, out long value)
    {
        value = 0;
        var idx = line.IndexOf(key, StringComparison.Ordinal);
        if (idx < 0) return;
        var sub = line[(idx + key.Length)..].Trim().TrimStart(':', '：', ' ', '\t');
        value = ParseSizeLabel(sub);
    }

    private static void TryParseMs(string line, out long value)
    {
        value = 0;
        var idx = line.IndexOf("耗时", StringComparison.Ordinal);
        if (idx < 0) return;
        var sub = line[(idx + 2)..].Trim().TrimStart(':', '：', ' ', '\t');
        var numStr = "";
        foreach (var c in sub)
        {
            if (char.IsDigit(c) || c == '.') numStr += c;
            else break;
        }
        if (double.TryParse(numStr, out var num))
        {
            value = sub.Contains('m') ? (long)(num * 60000) :
                    sub.Contains('秒') || sub.Contains('s') ? (long)(num * 1000) :
                    (long)num;
        }
    }
}
