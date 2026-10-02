<#
  dedup.ps1 —— 内容级重复文件清理（命令行版）
  ---------------------------------------------------------------------------
  判重依据是“文件内容”而不是“文件名去掉 (N)”，
  因此跨目录、跨改名、多次累加 (N) 的副本都能命中。默认动作仍是“移入隔离区”。
  必须用 UTF-8 with BOM 保存。

  示例：
    .\dedup.ps1 -Path F:\WeChat_old_3x -DryRun
    .\dedup.ps1 -Path F:\WeChat_old_3x -DryRun -ExportCsv plan.csv
    .\dedup.ps1 -Path F:\WeChat_old_3x -Verify Head -DryRun          # 只比头部（快，可能误判）
    .\dedup.ps1 -Path F:\WeChat_old_3x -Action Quarantine -Yes
    .\dedup.ps1 -Path F:\WeChat_old_3x -ListQuarantine
    .\dedup.ps1 -Path F:\WeChat_old_3x -RestoreQuarantine
    .\dedup.ps1 -Path F:\WeChat_old_3x -PurgeQuarantine -Yes
#>
[CmdletBinding()]
param(
    [string]$Path,
    [string[]]$Paths,           # 多目录扫描（覆盖 -Path）
    [string[]]$IncludeExt,      # 只包含这些扩展名（如 .jpg,.png）
    [string[]]$ExcludeExt,      # 排除这些扩展名
    [switch]$NoRecurse,
    [ValidateSet('Cleanest','Newest','Original','Highest')][string]$Strategy = 'Cleanest',
    [ValidateSet('Full','Head','Name','Size')][string]$Verify = 'Full',
    [int]$HeadKB = 32,
    [long]$MinSize = 1,
    [switch]$NoLinkCheck,
    [switch]$DryRun,
    [switch]$Yes,
    [ValidateSet('Quarantine','Permanent')][string]$Action = 'Quarantine',
    [string]$ExportCsv,
    [int]$MaxPrint = 15,
    [switch]$ListQuarantine,
    [switch]$ListOps,
    [string]$ProgressFile = '',
    [string]$SummaryFile = '',
    [switch]$RestoreQuarantine,
    [switch]$PurgeQuarantine
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$appDir = $PSScriptRoot
if (-not $appDir) { $appDir = (Get-Location).ProviderPath }
. (Join-Path $appDir 'dedup_core.ps1')

# ---------------- 多目录支持 ----------------
$scanRoots = @()
if ($Paths -and $Paths.Count -gt 0) {
    foreach ($p in $Paths) {
        if ([string]::IsNullOrWhiteSpace($p)) { continue }
        $p = $p.Trim()
        if (-not (Test-Path -LiteralPath $p)) { Write-Host ('警告：跳过不存在的路径 ' + $p) -ForegroundColor Yellow; continue }
        $scanRoots += (Resolve-Path -LiteralPath $p).ProviderPath
    }
    if ($scanRoots.Count -eq 0) { Write-Host '错误：没有有效的扫描路径' -ForegroundColor Red; exit 1 }
} else {
    if ([string]::IsNullOrWhiteSpace($Path)) { $Path = (Get-Location).ProviderPath }
    if (-not (Test-Path -LiteralPath $Path)) { Write-Host ('错误：找不到路径 ' + $Path) -ForegroundColor Red; exit 1 }
    $scanRoots = @((Resolve-Path -LiteralPath $Path).ProviderPath)
}
$root = $scanRoots[0]  # 主根目录（用于隔离区和日志）

# ---------------- 扩展名过滤 ----------------
$extFilter = $null
if ($IncludeExt -and $IncludeExt.Count -gt 0) {
    $extFilter = @{ Include = @($IncludeExt | ForEach-Object { if (-not $_.StartsWith('.')) { '.' + $_ } else { $_ } }); Exclude = @() }
} elseif ($ExcludeExt -and $ExcludeExt.Count -gt 0) {
    $extFilter = @{ Include = @(); Exclude = @($ExcludeExt | ForEach-Object { if (-not $_.StartsWith('.')) { '.' + $_ } else { $_ } }) }
}

Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ' 重复文件清理（内容级判重）' -ForegroundColor Cyan
if ($scanRoots.Count -gt 1) {
    Write-Host (' 目录     : ' + $scanRoots.Count + ' 个路径') -ForegroundColor Cyan
    foreach ($r in $scanRoots) { Write-Host ('           ' + $r) -ForegroundColor Gray }
} else {
    Write-Host (' 目录     : ' + $root) -ForegroundColor Cyan
}
if ($extFilter) {
    if ($extFilter.Include.Count -gt 0) { Write-Host (' 包含扩展 : ' + ($extFilter.Include -join ', ')) -ForegroundColor Gray }
    if ($extFilter.Exclude.Count -gt 0) { Write-Host (' 排除扩展 : ' + ($extFilter.Exclude -join ', ')) -ForegroundColor Gray }
}
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''

# ---------------- 历史操作 ----------------
if ($ListOps) {
    $ops = @(Get-OpHistory2 -Root $root -Limit 40)
    if ($ops.Count -eq 0) { Write-Host '还没有任何操作日志。' -ForegroundColor Green; return }
    Write-Host ('操作日志：' + (Get-OpLogDir -Root $root)) -ForegroundColor Yellow
    foreach ($o in $ops) {
        Write-Host ('  {0}  {1,-12} {2}' -f $o.ts, $o.op, $o.detail)
    }
    return
}

# ---------------- 操作日志 session ----------------
$opSession = New-OpSession2 -Root $root

# ---------------- 隔离区子命令 ----------------
if ($ListQuarantine) {
    $sessions = @(Get-QuarantineSessions2 -ScanRoot $root)
    if ($sessions.Count -eq 0) { Write-Host '隔离区为空。' -ForegroundColor Green; return }
    Write-Host ('隔离区：' + (Get-QuarantineRoot2 -ScanRoot $root)) -ForegroundColor Yellow
    foreach ($s in $sessions) {
        Write-Host ('  ' + $s.name + '   ' + $s.files + ' 个文件   ' + (Format-Size2 $s.bytes) + '   ' + $s.movedAt)
    }
    return
}
if ($RestoreQuarantine) {
    $sessions = @(Get-QuarantineSessions2 -ScanRoot $root)
    if ($sessions.Count -eq 0) { Write-Host '隔离区为空，无需还原。' -ForegroundColor Green; return }
    foreach ($s in $sessions) {
        $r = Restore-QuarantineSession2 -Session $s.path
        Write-Host ('  还原 ' + $s.name + ' ：成功 ' + $r.restored + ' 个，失败 ' + @($r.failed).Count + ' 个') -ForegroundColor Green
        try { Write-OpRecord2 -Root $root -Record ([ordered]@{ op = 'quarantine-restore'; ts = (Get-Date).ToString('s'); opId = $opSession.Id; root = $root; session = $s.path; files = $s.files; bytes = $s.bytes; restored = $r.restored; failedCount = @($r.failed).Count; detail = ('还原 ' + $s.name + ' : 成功 ' + $r.restored + ' 个，失败 ' + @($r.failed).Count + ' 个') }) -Kind 'restore' | Out-Null } catch { }
    }
    return
}
if ($PurgeQuarantine) {
    $sessions = @(Get-QuarantineSessions2 -ScanRoot $root)
    if ($sessions.Count -eq 0) { Write-Host '隔离区为空。' -ForegroundColor Green; return }
    foreach ($s in $sessions) { Write-Host ('  ' + $s.name + ' : ' + $s.files + ' 个文件，' + (Format-Size2 $s.bytes)) }
    if (-not $Yes) {
        $a = Read-Host '确认永久删除以上隔离文件？[y/N]'
        if ($a -notmatch '^[yY]') { Write-Host '已取消。' -ForegroundColor Magenta; return }
    }
    foreach ($s in $sessions) {
        [void](Remove-QuarantineSession2 -Session $s.path)
        try { Write-OpRecord2 -Root $root -Record ([ordered]@{ op = 'quarantine-purge'; ts = (Get-Date).ToString('s'); opId = $opSession.Id; root = $root; session = $s.path; files = $s.files; bytes = $s.bytes; detail = ('永久清空隔离区 ' + $s.name + ' : ' + $s.files + ' 个文件 / ' + (Format-Size2 $s.bytes)) }) -Kind 'purge' | Out-Null } catch { }
    }
    Write-Host '隔离区已清空。' -ForegroundColor Green
    return
}

# ---------------- 扫描 ----------------
Write-Host ('判重方式 : 内容哈希（SHA-256）  校验级别=' + $Verify + '  头部=' + $HeadKB + 'KB  最小大小=' + $MinSize + 'B') -ForegroundColor Gray
Write-Host ('保留策略 : ' + $Strategy + '   （Cleanest=名字最干净优先 | Newest=修改时间最新 | Original=无后缀原件优先 | Highest=(N)数字最大）') -ForegroundColor Gray
Write-Host ('硬链接检测: ' + (-not $NoLinkCheck)) -ForegroundColor Gray
Write-Host ''
Write-Host '正在扫描…' -ForegroundColor Gray

$ex = @($appDir)
$allScanResults = @()
$totalScanned = 0
foreach ($scanRoot in $scanRoots) {
    if ($scanRoots.Count -gt 1) { Write-Host ('正在扫描：' + $scanRoot) -ForegroundColor Cyan }
    $scanArgs = @{ Path = $scanRoot; Recurse = (-not $NoRecurse); Strategy = $Strategy; Verify = $Verify; HeadBytes = ([int64]$HeadKB * 1024); DetectLinks = (-not $NoLinkCheck); ExcludeDir = $ex; MinSize = $MinSize }
    if ($ProgressFile) { $scanArgs['ProgressFile'] = $ProgressFile }
    if ($extFilter) { $scanArgs['ExtFilter'] = $extFilter }
    $scan = Invoke-DedupScan2 @scanArgs
    $allScanResults += $scan
    $totalScanned += $scan.scannedFiles
    if ($scanRoots.Count -gt 1) { Write-Host ('  -> ' + $scan.totalGroups + ' 组 / ' + $scan.totalVictims + ' 个待处理') -ForegroundColor Gray }
}

# 合并多目录结果（跨目录重复组）
if ($allScanResults.Count -gt 1) {
    $scan = Merge-ScanResults -Results $allScanResults -Strategy $Strategy
} else {
    $scan = $allScanResults[0]
}
if ($SummaryFile) { try { ($scan | ConvertTo-Json -Depth 4 -Compress) | Set-Content -LiteralPath $SummaryFile -Encoding UTF8 } catch { } }
try {
    $scanRecord = [ordered]@{
        op = 'scan'; ts = (Get-Date).ToString('s'); opId = $opSession.Id
        root = $root; strategy = $Strategy; verify = $Verify; headKB = $HeadKB
        scannedFiles = $scan.scannedFiles; candidates = $scan.candidates
        preSurvivors = $scan.preSurvivors; fullHashed = $scan.fullHashed
        totalGroups = $scan.totalGroups; totalVictims = $scan.totalVictims
        nominalBytes = $scan.nominalBytes; realBytes = $scan.realBytes
        hardlinkGroups = $scan.hardlinkGroups; elapsedMs = $scan.elapsedMs
        detail = ('' + $scan.totalGroups + ' 组 / ' + $scan.totalVictims + ' 个文件 / ' + (Format-Size2 $scan.realBytes) + '，扫描 ' + $scan.scannedFiles + ' 个文件')
    }
    Write-OpRecord2 -Root $root -Record $scanRecord -Kind 'scan' | Out-Null
    [void](Export-DedupPlanFile2 -Scan $scan -OutFile (Join-Path $opSession.Dir 'plan.csv'))
} catch { Write-Host ('日志写入失败：' + $_.Exception.Message) -ForegroundColor Yellow }

Write-Host ''
Write-Host ('已扫描 ' + $scan.scannedFiles + ' 个文件，跳过 ' + $scan.skippedDirs + ' 个无权限目录，耗时 ' + [math]::Round($scan.elapsedMs / 1000, 1) + ' 秒。')
if ($scan.scannedFiles -eq 0) { Write-Host '没有扫到任何文件，请检查目录。' -ForegroundColor Yellow; return }
if ($scan.totalGroups -eq 0) { Write-Host '未发现重复文件组，无需处理。' -ForegroundColor Green; return }

Write-Host ''
Write-Host ('发现 ' + $scan.totalGroups + ' 组重复，待处理 ' + $scan.totalVictims + ' 个文件。') -ForegroundColor Yellow

$shown = 0
foreach ($g in $scan.groups) {
    if ($shown -ge $MaxPrint) { break }
    $shown++
    Write-Host ('[' + $shown + '] ' + $g.dir) -ForegroundColor White
    Write-Host ('    保留  ' + $g.keeper.name + '   ' + $g.keeper.mtime + '   ' + (Format-Size2 $g.keeper.size)) -ForegroundColor Green
    foreach ($v in $g.victims) {
        $tag = ''
        if ($v.shared) { $tag = '  <<< 硬链接，删了不省空间' }
        Write-Host ('    删除  ' + $v.name + '   ' + $v.mtime + '   ' + (Format-Size2 $v.size) + $tag) -ForegroundColor Yellow
    }
}
if ($scan.totalGroups -gt $shown) { Write-Host ('… 其余 ' + ($scan.totalGroups - $shown) + ' 组未在屏幕展开（可加 -ExportCsv 导出）') -ForegroundColor Gray }

Write-Host ''
Write-Host ('表面可释放 : ' + (Format-Size2 $scan.nominalBytes)) -ForegroundColor Cyan
Write-Host ('真实可释放 : ' + (Format-Size2 $scan.realBytes)) -ForegroundColor Cyan
if ($scan.sharedVictims -gt 0) { Write-Host ('  其中 ' + $scan.sharedVictims + ' 个是硬链接，删除它们不会释放空间。') -ForegroundColor Yellow }
if (-not $scan.linkDetectOk) { Write-Host '  注意：本机硬链接检测不可用，真实可释放为估算值。' -ForegroundColor Yellow }
Write-Host ('  流水线：索引 ' + $scan.scannedFiles + ' -> 大小分组候选 ' + $scan.candidates + ' -> prehash 幸存 ' + $scan.preSurvivors + ' -> 全量读取 ' + $scan.fullHashed) -ForegroundColor Gray

if ($ExportCsv) {
    $f = Export-DedupPlan2 -Scan $scan -OutFile $ExportCsv
    Write-Host ('计划已导出：' + $f) -ForegroundColor Green
}

$victims = New-Object System.Collections.ArrayList
foreach ($g in $scan.groups) { foreach ($v in $g.victims) { [void]$victims.Add($v.path) } }

if ($DryRun) { Write-Host ''; Write-Host '仅预览模式：未改动任何文件。' -ForegroundColor Magenta; return }
if ($victims.Count -eq 0) { Write-Host '没有需要处理的文件。' -ForegroundColor Green; return }

Write-Host ''
if ($Action -eq 'Permanent') {
    Write-Host ('将要【永久删除】 ' + $victims.Count + ' 个文件，不可恢复。') -ForegroundColor Red
} else {
    Write-Host ('将要【移入隔离区】 ' + $victims.Count + ' 个文件（可还原）。') -ForegroundColor Cyan
}
if (-not $Yes) {
    $a = Read-Host '确认执行？[y/N]'
    if ($a -notmatch '^[yY]') { Write-Host '已取消，未改动任何文件。' -ForegroundColor Magenta; return }
}

if ($Action -eq 'Permanent') {
    $ok = 0; $bytes = [long]0; $fail = 0
    foreach ($p in $victims) {
        try {
            if (-not (Test-Path -LiteralPath $p)) { continue }
            $sz = [long]((New-Object System.IO.FileInfo($p)).Length)
            Remove-Item -LiteralPath $p -Force -ErrorAction Stop
            $ok++; $bytes += $sz
        } catch { $fail++; Write-Host ('  失败：' + $p + ' -> ' + $_.Exception.Message) -ForegroundColor Red }
    }
    Write-Host ''
    Write-Host ('完成。永久删除 ' + $ok + ' 个，释放 ' + (Format-Size2 $bytes) + '，失败 ' + $fail + ' 个。')
    try {
        $delRecord = [ordered]@{ op = 'purge-permanent'; ts = (Get-Date).ToString('s'); opId = $opSession.Id; root = $root; method = 'permanent-delete'; moved = $ok; bytes = $bytes; failedCount = $fail; session = '-'; detail = ('永久删除 ' + $ok + ' 个，释放 ' + (Format-Size2 $bytes) + '，失败 ' + $fail) }
        Write-OpRecord2 -Root $root -Record $delRecord -Kind 'purge' | Out-Null
    } catch { Write-Host ('日志写入失败：' + $_.Exception.Message) -ForegroundColor Yellow } -ForegroundColor Green
} else {
    $r = Move-ToQuarantine2 -ScanRoot $root -Paths $victims
    Write-Host ''
    Write-Host ('完成。已移入隔离区 ' + $r.moved + ' 个（' + (Format-Size2 $r.bytes) + '），失败 ' + @($r.failed).Count + ' 个。') -ForegroundColor Green
    Write-Host ('隔离区位置：' + $r.session) -ForegroundColor Gray
    try {
        $rec = [ordered]@{ op = 'quarantine'; ts = (Get-Date).ToString('s'); opId = $opSession.Id; root = $root; method = 'quarantine'; moved = $r.moved; bytes = $r.bytes; failedCount = @($r.failed).Count; totalVictims = $scan.totalVictims; nominalBytes = $scan.nominalBytes; realBytes = $scan.realBytes; session = $r.session; detail = ('移入隔离区 ' + $r.moved + ' 个 / ' + (Format-Size2 $r.bytes) + '，失败 ' + @($r.failed).Count + '，共处理 ' + $scan.totalGroups + ' 组') }
        Write-OpRecord2 -Root $root -Record $rec -Kind 'quarantine' | Out-Null
        $det = New-Object System.Collections.ArrayList
        foreach ($e in $r.entries) { [void]$det.Add([ordered]@{ opId = $opSession.Id; ts = (Get-Date).ToString('s'); original = $e.original; stored = $e.stored; size = $e.size }) }
        $detFile = Join-Path $opSession.Dir 'moved-files.jsonl'
        $sb2 = New-Object System.Text.StringBuilder
        foreach ($x in $det) { [void]$sb2.AppendLine(($x | ConvertTo-Json -Depth 4 -Compress)) }
        [System.IO.File]::WriteAllText($detFile, $sb2.ToString(), (New-Object System.Text.UTF8Encoding($false)))
        if (@($r.failed).Count -gt 0) {
            $sb3 = New-Object System.Text.StringBuilder
            [void]$sb3.AppendLine('path,reason')
            foreach ($x in @($r.failed)) { [void]$sb3.AppendLine((Csv-Safe2 ([string]$x.path)) + ',' + (Csv-Safe2 ([string]$x.reason))) }
            [System.IO.File]::WriteAllText((Join-Path $opSession.Dir 'failed.csv'), $sb3.ToString(), (New-Object System.Text.UTF8Encoding($true)))
        }
    } catch { Write-Host ('日志写入失败：' + $_.Exception.Message) -ForegroundColor Yellow }
    Write-Host '确认无误后，用 -PurgeQuarantine 永久清空；要反悔就运行 -RestoreQuarantine。' -ForegroundColor Gray
}
