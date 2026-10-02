<#
  dedup_server.ps1 —— 重复文件清理 本地网页服务（内容级判重）
  ---------------------------------------------------------------------------
  特性：
    1) 引擎为 dedup_core.ps1 的 Invoke-DedupScan2 —— 按内容哈希判重，
       跨目录 / 跨改名 / 多层 (N) 后缀都能命中。
    2) 扫描改为后台作业：POST /api/scan 立即返回，前端轮询 GET /api/progress，
       因此扫描期间界面不会卡死（一次性全量哈希要大几十秒到几分钟）。
    3) 汇总里带上真实/表面可释放、硬链接组数、流水线各阶段计数。
    4) 所有操作写入 _dedup_logs（append-only，见 dedup_core.ps1）。
  必须用 UTF-8 with BOM 保存。
#>
param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [string]$DefaultPath = '',
    [int]$HeadKB = 32,
    [ValidateSet('Full','Head')][string]$Verify = 'Full',
    [string]$TokenFile = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:AppDir = $PSScriptRoot
if (-not $script:AppDir) { try { $script:AppDir = Split-Path -Parent $PSCommandPath } catch { } }
if (-not $script:AppDir) { try { $script:AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path } catch { } }
if (-not $script:AppDir) { $script:AppDir = (Get-Location).ProviderPath }
$script:PageSize = 50
. (Join-Path $script:AppDir 'dedup_core.ps1')

function Write-Log2 { param([string]$Message) Write-Host ((Get-Date).ToString('HH:mm:ss') + '  ' + $Message) }

# ---------------- 配置 ----------------
$config = [ordered]@{
    defaultPath = ''
    port        = 0
    openBrowser = $true
    strategy    = 'Cleanest'
    verify      = $Verify
    detectLinks = $true
    excludeDirs = @()
    headKB      = $HeadKB
}
$cfgFile = Join-Path $script:AppDir 'config.json'
if (Test-Path -LiteralPath $cfgFile) {
    try {
        $j = Get-Content -Raw -LiteralPath $cfgFile -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $j.PSObject.Properties) {
            if ($config.Contains($p.Name) -and $p.Value -ne $null) { $config[$p.Name] = $p.Value }
        }
    } catch { }
}
if ($DefaultPath) { $config['defaultPath'] = $DefaultPath }
if (-not $config['defaultPath']) {
    $parent = Split-Path -Parent $script:AppDir
    if ($parent) { $config['defaultPath'] = $parent } else { $config['defaultPath'] = $script:AppDir }
}
if (-not $Port -and $config['port']) { $Port = [int]$config['port'] }
# v1 的 config.json 里 verify=Size、strategy=Newest，这些在 v2 不是合法值，必须清洗
if (@('Cleanest','Newest','Original','Highest') -notcontains [string]$config['strategy']) { $config['strategy'] = 'Cleanest' }
if (@('Full','Head') -notcontains [string]$config['verify']) { $config['verify'] = 'Full' }
if ([int]$config['headKB'] -lt 1 -or [int]$config['headKB'] -gt 1024) { $config['headKB'] = 32 }
if (-not $PSBoundParameters.ContainsKey('HeadKB') -and $config['headKB']) { $HeadKB = [int]$config['headKB'] }
$openBrowser = (-not $NoBrowser) -and [bool]$config['openBrowser']

function Get-CRLF { return ([string][char]13 + [string][char]10) }

# ---------------- HTTP 小工具 ----------------
function Parse-Query {
    param([string]$QueryString)
    $h = @{}
    if (-not $QueryString) { return $h }
    foreach ($pair in (($QueryString.TrimStart('?') -split '&'))) {
        if (-not $pair) { continue }
        $kv = $pair -split '=', 2
        $k = [System.Uri]::UnescapeDataString($kv[0])
        $v = ''
        if ($kv.Count -eq 2) { $v = [System.Uri]::UnescapeDataString($kv[1]) }
        $h[$k] = $v
    }
    return $h
}

function Read-HttpRequest {
    param([System.Net.Sockets.NetworkStream]$Stream)
    $crlf = Get-CRLF
    try { $Stream.ReadTimeout = 15000 } catch { }
    $buf = New-Object byte[] 16384
    $ms = New-Object System.IO.MemoryStream
    $headerEnd = -1
    $text = ''
    while ($true) {
        $n = 0
        try { $n = $Stream.Read($buf, 0, $buf.Length) } catch { return $null }
        if ($n -le 0) { break }
        $ms.Write($buf, 0, $n)
        $text = [System.Text.Encoding]::ASCII.GetString($ms.ToArray())
        $headerEnd = $text.IndexOf($crlf + $crlf)
        if ($headerEnd -ge 0) { break }
        if ($ms.Length -gt 131072) { return $null }
    }
    if ($headerEnd -lt 0) { return $null }
    $bytes = $ms.ToArray()
    $lines = $text.Substring(0, $headerEnd) -split [regex]::Escape($crlf)
    $parts = @($lines[0] -split ' ')
    if ($parts.Count -lt 3) { return $null }
    $headers = @{}
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $idx = $lines[$i].IndexOf(':')
        if ($idx -gt 0) { $headers[$lines[$i].Substring(0, $idx).Trim().ToLowerInvariant()] = $lines[$i].Substring($idx + 1).Trim() }
    }
    $len = 0
    if ($headers.ContainsKey('content-length')) { [void][int]::TryParse([string]$headers['content-length'], [ref]$len) }
    if ($len -lt 0 -or $len -gt 16777216) { return $null }
    $bodyBytes = New-Object byte[] $len
    $have = 0
    $bodyStart = $headerEnd + 4
    $avail = $bytes.Length - $bodyStart
    if ($avail -gt 0) {
        $cp = [Math]::Min($avail, $len)
        [System.Array]::Copy($bytes, $bodyStart, $bodyBytes, 0, $cp)
        $have = $cp
    }
    while ($have -lt $len) {
        $n = 0
        try { $n = $Stream.Read($bodyBytes, $have, $len - $have) } catch { break }
        if ($n -le 0) { break }
        $have += $n
    }
    return [ordered]@{
        Method  = $parts[0]
        Target  = $parts[1]
        Headers = $headers
        Body    = [System.Text.Encoding]::UTF8.GetString($bodyBytes, 0, $have)
    }
}

function Write-HttpResponse {
    param($Stream, [int]$Code, [string]$ContentType, [byte[]]$Body, [string]$ExtraHeaders = '')
    if ($Body -eq $null) { $Body = New-Object byte[] 0 }
    $crlf = Get-CRLF
    $reason = 'OK'
    if ($Code -eq 400) { $reason = 'Bad Request' }
    elseif ($Code -eq 403) { $reason = 'Forbidden' }
    elseif ($Code -eq 404) { $reason = 'Not Found' }
    elseif ($Code -eq 405) { $reason = 'Method Not Allowed' }
    elseif ($Code -eq 500) { $reason = 'Internal Server Error' }
    $head = 'HTTP/1.1 ' + $Code + ' ' + $reason + $crlf
    $head += 'Content-Type: ' + $ContentType + $crlf
    $head += 'Content-Length: ' + $Body.Length + $crlf
    $head += 'Cache-Control: no-store' + $crlf
    $head += 'X-Content-Type-Options: nosniff' + $crlf
    $head += 'Connection: close' + $crlf
    if ($ExtraHeaders) { $head += $ExtraHeaders }
    $head += $crlf
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    try {
        $Stream.Write($hb, 0, $hb.Length)
        if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
        $Stream.Flush()
    } catch { }
}

function Write-JsonResponse {
    param($Stream, $Object, [int]$Code = 200)
    $json = $Object | ConvertTo-Json -Depth 12 -Compress
    Write-HttpResponse -Stream $Stream -Code $Code -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
}

function Get-BodyObject {
    param([string]$Body)
    if (-not $Body) { return $null }
    try { return ($Body | ConvertFrom-Json) } catch { return $null }
}

function Get-RequestedPaths {
    param($Deletable, $JsonBody)
    $out = New-Object System.Collections.ArrayList
    if ($JsonBody -eq $null) { return $out }
    if (-not ($JsonBody.PSObject.Properties.Name -contains 'paths')) { return $out }
    foreach ($p in @($JsonBody.paths)) {
        $ps = [string]$p
        if ($ps -and $Deletable.ContainsKey($ps)) { [void]$out.Add($ps) }
    }
    return $out
}

# ---------------- 状态 ----------------
$state = @{
    Token     = [guid]::NewGuid().ToString('N')
    Stop      = $false
    Scan      = $null
    Deletable = @{}
    Selected  = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    ScanRoot  = ''
    Busy      = $false
    Progress  = [ordered]@{ phase = 'idle'; message = '空闲'; current = 0; total = 0; percent = 0; startedAt = ''; elapsedSec = 0; error = '' }
    OpSession = $null
    Job       = $null
}

function Start-BackgroundScan {
    param([hashtable]$State, [string]$Path, [bool]$Recurse, [string]$Strategy, [string]$VerifyMode, [int]$HeadKBytes, [bool]$Links, [string[]]$Exclude)
    $stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
    $base = Join-Path ([System.IO.Path]::GetTempPath()) ('dedup-scan-' + $stamp + '-' + ([guid]::NewGuid().ToString('N').Substring(0,6)))
[void][System.IO.Directory]::CreateDirectory($base)
    $csv = Join-Path $base 'plan.csv'
    $sumFile = Join-Path $base 'summary.txt'
    $prog = Join-Path $base 'progress.json'
    $errFile = Join-Path $base 'err.txt'
    $cli = Join-Path $script:AppDir 'dedup.ps1'
    # 注意：Start-Process 的 -ArgumentList 不会自动加引号，含空格的路径必须显式加引号
    $q = [char]34
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ($q + $cli + $q), '-Path', ($q + $Path + $q), '-Strategy', $Strategy, '-Verify', $VerifyMode, '-HeadKB', ([string]$HeadKBytes), '-DryRun', '-ExportCsv', ($q + $csv + $q), '-ProgressFile', ($q + $prog + $q), '-SummaryFile', ($q + $sumFile + $q))
    if (-not $Recurse) { $args += '-NoRecurse' }
    if (-not $Links) { $args += '-NoLinkCheck' }
    $proc = Start-Process -FilePath 'powershell' -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput ((Join-Path $base 'out.log')) -RedirectStandardError ($errFile)
    $State.Busy = $true
    $State.Scan = $null
    $State.Progress = [ordered]@{ phase = 'starting'; message = '正在启动扫描进程…'; current = 0; total = 0; percent = 0; startedAt = (Get-Date).ToString('s'); elapsedSec = 0; error = '' }
    return [ordered]@{ pid = $proc.Id; proc = $proc; base = $base; csv = $csv; summary = $sumFile; progress = $prog; err = $errFile }
}

# 读取进度文件；进程结束后用 summary.txt + plan.csv 重建扫描结果
function Update-BackgroundScan {
    param([hashtable]$State)
    $job = $State.Job
    if ($job -eq $null) { return }
    # 1) 进度
    if (Test-Path -LiteralPath $job.progress) {
        try {
            $pj = Get-Content -Raw -LiteralPath $job.progress -Encoding UTF8 | ConvertFrom-Json
            $State.Progress = [ordered]@{ phase = [string]$pj.phase; message = [string]$pj.message; current = [long]$pj.current; total = [long]$pj.total; percent = [double]$pj.percent; startedAt = [string]$State.Progress.startedAt; elapsedSec = [double]$pj.elapsedSec; error = '' }
        } catch { }
    }
    # 2) 进程是否结束
    $exited = $false
    try { $exited = $job.proc.HasExited } catch { $exited = $true }
    if (-not $exited) { return }
    # 3) 收尾：解析 summary.txt 与 plan.csv
    $stateErr = ''
    if (Test-Path -LiteralPath $job.err) {
        try { $stateErr = (Get-Content -Raw -LiteralPath $job.err -Encoding UTF8).Trim() } catch { }
    }
    $sum = $null
    if (Test-Path -LiteralPath $job.summary) {
        try { $sum = Get-Content -Raw -LiteralPath $job.summary -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    if ($sum -eq $null) {
        $State.Busy = $false
        $msg = '扫描未产出汇总'
        if ($stateErr) { $msg = $msg + '：' + $stateErr }
        $State.Progress = [ordered]@{ phase = 'error'; message = $msg; current = 0; total = 0; percent = 0; startedAt = [string]$State.Progress.startedAt; elapsedSec = [double]$State.Progress.elapsedSec; error = $msg }
        $State.Job = $null
        return
    }
    # 4) 解析计划 CSV，重建分组
    $groups = New-Object System.Collections.ArrayList
    $deletable = @{}
    try {
        $rows = @(Import-Csv -LiteralPath $job.csv -Encoding UTF8)
        $byGroup = @{}
        $order = New-Object System.Collections.ArrayList
        foreach ($row in $rows) {
            $gid = [string]$row.'组号'
            if (-not $byGroup.ContainsKey($gid)) {
                $byGroup[$gid] = [ordered]@{ dir = [string]$row.'目录'; keeper = $null; victims = (New-Object System.Collections.ArrayList) }
                [void]$order.Add($gid)
            }
            if ([string]$row.'角色' -eq '保留') {
                $byGroup[$gid].keeper = [ordered]@{ name = [string]$row.'文件名'; path = [string]$row.'完整路径'; mtime = [string]$row.'修改时间'; size = [long]$row.'大小(字节)'; links = [int]$row.'硬链接数' }
            } else {
                $v = [ordered]@{ name = [string]$row.'文件名'; path = [string]$row.'完整路径'; mtime = [string]$row.'修改时间'; size = [long]$row.'大小(字节)'; links = [int]$row.'硬链接数'; shared = ([int]$row.'硬链接数' -gt 1) }
                [void]$byGroup[$gid].victims.Add($v)
                $deletable[[string]$v.path] = [string]$row.'目录'
            }
        }
        foreach ($gid in $order) {
            $g = $byGroup[$gid]
            if ($g.keeper -eq $null) { continue }
            $nom = [long]0; $real = [long]0
            foreach ($v in $g.victims) { $nom += [long]$v.size; if (-not $v.shared) { $real += [long]$v.size } }
            [void]$groups.Add([ordered]@{ dir = $g.dir; keeper = $g.keeper; victims = @($g.victims); nominal = $nom; real = $real })
        }
    } catch { }
    # 5) 选中默认：全部待删项
    $State.Selected.Clear()
    $State.Selected.Clear()
    $verifiedCount = 0; $differCount = 0
    foreach ($g in $groups) { foreach ($v in $g.victims) { [void]$State.Selected.Add([string]$v.path) } }
    foreach ($row in $rows) { if ([string]$row.'角色' -eq '保留') { continue }; if ([string]$row.'状态' -eq 'differ') { $differCount++ } else { $verifiedCount++ } }
    $result = [ordered]@{
        root = [string]$sum.root
        strategy = [string]$sum.strategy
        verify = [string]$sum.verify
        linkDetectOk = [bool]$sum.linkDetectOk
        scannedFiles = [long]$sum.scannedFiles
        skippedDirs = [long]$sum.skippedDirs
        candidates = [long]$sum.candidates
        preSurvivors = [long]$sum.preSurvivors
        fullHashed = [long]$sum.fullHashed
        totalGroups = [int]$sum.totalGroups
        totalVictims = [int]$sum.totalVictims
        sharedVictims = [int]$sum.sharedVictims
        verifiedVictims = $verifiedCount
        differVictims = $differCount
        hardlinkGroups = [int]$sum.hardlinkGroups
        nominalBytes = [long]$sum.nominalBytes
        realBytes = [long]$sum.realBytes
        elapsedMs = [long]$sum.elapsedMs
        groups = @($groups)
        deletable = $deletable
    }
    $State.Scan = $result
    $State.ScanRoot = [string]$result.root
    $State.Deletable = $deletable
    $State.Busy = $false
    $State.Progress = [ordered]@{ phase = 'done'; message = ('完成：' + $result.totalGroups + ' 组重复'); current = $result.scannedFiles; total = $result.scannedFiles; percent = 100; startedAt = [string]$State.Progress.startedAt; elapsedSec = [Math]::Round($result.elapsedMs / 1000, 1); error = '' }
    $State.Job = $null
}

# ---------------- 自检（不启动服务，只验证后台扫描链路） ----------------
if ($SelfTest) {
    Write-Host '开始自检：后台扫描链路…'
    $ex = @($script:AppDir)
    $state.Job = Start-BackgroundScan -State $state -Path ([string]$config['defaultPath']) -Recurse $true -Strategy ([string]$config['strategy']) -VerifyMode ([string]$config['verify']) -HeadKBytes $HeadKB -Links $true -Exclude $ex
    while ($state.Busy) { Update-BackgroundScan -State $state; Start-Sleep -Milliseconds 500 }
    if ($state.Scan) {
        $r = $state.Scan
        Write-Host ('自检成功：scanned=' + $r.scannedFiles + ' groups=' + $r.totalGroups + ' victims=' + $r.totalVictims + ' real=' + $r.realBytes + ' phase=' + $state.Progress.phase)
    } else {
        Write-Host ('自检失败：' + [string]$state.Progress.message) -ForegroundColor Red
    }
    exit 0
}
# ---------------- 端口 ----------------
if ($Port -gt 0) { $tryPorts = @($Port) } else { $tryPorts = 8717..8730 }
$listener = $null
$chosen = 0
foreach ($p in $tryPorts) {
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
        $l.Start()
        $listener = $l
        $chosen = $p
        break
    } catch { }
}
if ($listener -eq $null) {
    Write-Host '无法绑定本地端口（8717-8730 均被占用），请用 -Port 指定其他端口。' -ForegroundColor Red
    exit 1
}

$baseURL = 'http://127.0.0.1:' + $chosen + '/'
if ($TokenFile) {
    try { [System.IO.File]::WriteAllText($TokenFile, $state.Token, (New-Object System.Text.UTF8Encoding($false))) } catch { }
}
$tokenURL = $baseURL + '?t=' + $state.Token
Write-Host ''
Write-Host '  重复文件清理 v2 · 本地服务已启动（内容级判重）' -ForegroundColor Green
Write-Host ('  地址        ：' + $baseURL) -ForegroundColor Green
Write-Host ('  默认目录    ：' + [string]$config['defaultPath']) -ForegroundColor Gray
Write-Host ('  当前配置    ：保留=' + [string]$config['strategy'] + '  校验=' + [string]$config['verify'] + '  头部=' + $HeadKB + 'KB') -ForegroundColor Gray
Write-Host ('  界面        ：' + (Join-Path $script:AppDir 'dedup_ui.html')) -ForegroundColor Gray
Write-Host '  退出        ：Ctrl+C，或网页里的「关闭服务」' -ForegroundColor Gray
Write-Host ''
if ($openBrowser) {
    try { Start-Process $tokenURL } catch { Write-Host ('自动打开浏览器失败，请手动访问：' + $tokenURL) -ForegroundColor Yellow }
} else {
    Write-Host ('  接入地址(含令牌)：' + $tokenURL) -ForegroundColor Yellow
    Write-Host '  （-NoBrowser 模式；把上面地址粘进浏览器即可打开界面）' -ForegroundColor DarkGray
}



# ---------------- 主循环 ----------------
while (-not $state.Stop) {
    # 后台扫描：读进度 / 收尾
    Update-BackgroundScan -State $state

    $client = $null
    try { $client = $listener.AcceptTcpClient() } catch { break }
    $stream = $null
    try {
        $client.NoDelay = $true
        $stream = $client.GetStream()
        $req = Read-HttpRequest -Stream $stream
        if ($req -eq $null) { continue }

        $target = [string]$req.Target
        $qi = $target.IndexOf('?')
        $pathOnly = $target
        $query = @{}
        if ($qi -ge 0) { $pathOnly = $target.Substring(0, $qi); $query = Parse-Query $target.Substring($qi) }
        $pathOnly = [System.Uri]::UnescapeDataString($pathOnly)

        $hostHdr = ''
        if ($req.Headers.ContainsKey('host')) { $hostHdr = [string]$req.Headers['host'] }
        if ($hostHdr -ne '' -and -not ($hostHdr.StartsWith('127.0.0.1') -or $hostHdr.StartsWith('localhost'))) {
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '仅允许本机访问' }) -Code 403
            continue
        }

        if ($pathOnly -eq '/' -or $pathOnly -eq '/index.html') {
            $htmlPath = Join-Path $script:AppDir 'dedup_ui.html'
            if (-not (Test-Path -LiteralPath $htmlPath)) { Write-HttpResponse -Stream $stream -Code 500 -ContentType 'text/plain; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('找不到界面文件 dedup_ui.html')); continue }
            $html = Get-Content -Raw -LiteralPath $htmlPath -Encoding UTF8
            if ($html.Length -gt 0 -and [int][char]$html[0] -eq 0xFEFF) { $html = $html.Substring(1) }
            $html = $html.Replace('__TOKEN__', $state.Token)
            Write-HttpResponse -Stream $stream -Code 200 -ContentType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            continue
        }

        if (-not $pathOnly.StartsWith('/api/')) {
            Write-HttpResponse -Stream $stream -Code 404 -ContentType 'text/plain; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('404'))
            continue
        }

        if ([string]$query['t'] -ne $state.Token) {
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '令牌无效，请从启动时打开的页面操作' }) -Code 403
            continue
        }

        $bodyObj = Get-BodyObject -Body ([string]$req.Body)

        if ($pathOnly -eq '/api/config') {
            Write-JsonResponse -Stream $stream -Object ([ordered]@{
                ok = $true; basePath = [string]$config['defaultPath']; appDir = $script:AppDir
                strategy = [string]$config['strategy']; verify = [string]$config['verify']; detectLinks = [bool]$config['detectLinks']; headKB = $HeadKB; engine = 'v2-content-hash'
            })
            continue
        }

        if ($pathOnly -eq '/api/progress') {
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; busy = [bool]$state.Busy; progress = $state.Progress })
            continue
        }

        if ($pathOnly -eq '/api/scan') {
            if ($req.Method -ne 'POST') { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = 'method' }) -Code 405; continue }
            if ($state.Busy) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '已有扫描在进行中' }) -Code 400; continue }
            $p = [string]$config['defaultPath']
            $recurse = $true; $strategy = [string]$config['strategy']; $verifyMode = [string]$config['verify']; $links = [bool]$config['detectLinks']; $hk = $HeadKB
            if ($bodyObj -ne $null) {
                $names = $bodyObj.PSObject.Properties.Name
                if ($names -contains 'path' -and $bodyObj.path) { $p = [string]$bodyObj.path }
                if ($names -contains 'recurse') { $recurse = [bool]$bodyObj.recurse }
                if ($names -contains 'strategy' -and $bodyObj.strategy) { $strategy = [string]$bodyObj.strategy }
                if ($names -contains 'verify' -and $bodyObj.verify) { $verifyMode = [string]$bodyObj.verify }
                if ($names -contains 'detectLinks') { $links = [bool]$bodyObj.detectLinks }
                if ($names -contains 'headKB' -and $bodyObj.headKB) { $hk = [int]$bodyObj.headKB }
            }
            if (-not (Test-Path -LiteralPath $p)) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = ('找不到路径：' + $p) }) -Code 400; continue }
            $ex = New-Object System.Collections.ArrayList
            [void]$ex.Add($script:AppDir)
            foreach ($e in @($config['excludeDirs'])) { if ($e) { [void]$ex.Add([string]$e) } }
            try {
                $state.Job = Start-BackgroundScan -State $state -Path $p -Recurse $recurse -Strategy $strategy -VerifyMode $verifyMode -HeadKBytes $hk -Links $links -Exclude $ex.ToArray()
                Write-Log2 ('开始扫描：' + $p + '  （策略 ' + $strategy + ' / 校验 ' + $verifyMode + ' / 头部 ' + $hk + 'KB）')
                Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; started = $true; message = '扫描已开始，请轮询进度' })
            } catch {
                $state.Busy = $false
                Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = $_.Exception.Message }) -Code 500
            }
            continue
        }

        if ($pathOnly -eq '/api/page') {
            if ($state.Scan -eq $null) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '尚未扫描' }) -Code 400; continue }
            $offset = 0; $limit = $script:PageSize; $filter = ''
            if ($query['offset']) { [void][int]::TryParse([string]$query['offset'], [ref]$offset) }
            if ($query['limit']) { [void][int]::TryParse([string]$query['limit'], [ref]$limit) }
            if ($query['filter']) { $filter = [string]$query['filter'] }
            $minKB = 0
            if ($query['minKB']) { [void][int]::TryParse([string]$query['minKB'], [ref]$minKB) }
            if ($limit -lt 1 -or $limit -gt 500) { $limit = $script:PageSize }
            if ($offset -lt 0) { $offset = 0 }
            $list = @($state.Scan.groups)
            if ($filter) {
                $f = $filter.ToLowerInvariant()
                $list = @($list | Where-Object { ([string]$_['dir']).ToLowerInvariant().Contains($f) -or (@($_['victims'] | Where-Object { ([string]$_['name']).ToLowerInvariant().Contains($f) }).Count -gt 0) })
            }
            if ($minKB -gt 0) {
                $minBytes = [int64]$minKB * 1024
                $list = @($list | Where-Object { [int64]$_['real'] -ge $minBytes })
            }
            $total = $list.Count
            $page = @($list | Select-Object -Skip $offset -First $limit)
            $out = New-Object System.Collections.ArrayList
            foreach ($g in $page) {
                $vs = New-Object System.Collections.ArrayList
                foreach ($v in $g.victims) {
                    [void]$vs.Add([ordered]@{ name = $v.name; path = $v.path; mtime = $v.mtime; size = $v.size; links = $v.links; shared = [bool]$v.shared; selected = $state.Selected.Contains([string]$v.path) })
                }
                [void]$out.Add([ordered]@{ dir = $g.dir; keeper = $g.keeper; victims = @($vs); nominal = $g.nominal; real = $g.real })
            }
            $selBytes = [int64]0
            foreach ($g in $state.Scan.groups) { foreach ($v in $g.victims) { if ($state.Selected.Contains([string]$v.path)) { $selBytes += [int64]$v.size } } }
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; offset = $offset; limit = $limit; total = $total; groups = @($out); selectedNow = $state.Selected.Count; selectedBytes = $selBytes })
            continue
        }

        if ($pathOnly -eq '/api/select') {
            if ($req.Method -ne 'POST') { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = 'method' }) -Code 405; continue }
            $mode = ''
            $paths = @()
            if ($bodyObj -ne $null) {
                $names = $bodyObj.PSObject.Properties.Name
                if ($names -contains 'mode') { $mode = [string]$bodyObj.mode }
                if ($names -contains 'paths') { $paths = @($bodyObj.paths) }
            }
            if ($paths.Count -gt 0) {
                $sel = $true
                if ($bodyObj.PSObject.Properties.Name -contains 'selected') { $sel = [bool]$bodyObj.selected }
                foreach ($p in $paths) {
                    $ps = [string]$p
                    if (-not $state.Deletable.ContainsKey($ps)) { continue }
                    if ($sel) { [void]$state.Selected.Add($ps) } else { [void]$state.Selected.Remove($ps) }
                }
            } elseif ($state.Scan -ne $null) {
                if ($mode -eq 'all' -or $mode -eq 'default') {
                    foreach ($g in $state.Scan.groups) { foreach ($v in $g.victims) { [void]$state.Selected.Add([string]$v.path) } }
                } elseif ($mode -eq 'none') { $state.Selected.Clear() }
            }
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; selectedNow = $state.Selected.Count })
            continue
        }

        if ($pathOnly -eq '/api/quarantine' -and $req.Method -eq 'POST') {
            if ($state.Scan -eq $null) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '尚未扫描' }) -Code 400; continue }
            $paths = Get-RequestedPaths -Deletable $state.Deletable -JsonBody $bodyObj
            if ($paths.Count -eq 0) { $paths = @($state.Selected) }
            if ($paths.Count -eq 0) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '没有勾选任何文件' }) -Code 400; continue }
            try {
                $r = Move-ToQuarantine2 -ScanRoot $state.ScanRoot -Paths $paths
                $session = New-OpSession2 -Root $state.ScanRoot
                try {
                    $rec = [ordered]@{ op = 'quarantine'; ts = (Get-Date).ToString('s'); opId = $session.Id; root = $state.ScanRoot; method = 'quarantine'; moved = $r.moved; bytes = $r.bytes; failedCount = @($r.failed).Count; session = $r.session; detail = ('移入隔离区 ' + $r.moved + ' 个 / ' + (Format-Size2 $r.bytes) + '，失败 ' + @($r.failed).Count) }
                    Write-OpRecord2 -Root $state.ScanRoot -Record $rec -Kind 'quarantine' | Out-Null
                    $sb = New-Object System.Text.StringBuilder
                    foreach ($e in $r.entries) { $o = [ordered]@{ original = $e.original; stored = $e.stored; size = $e.size; movedAt = $e.movedAt }; [void]$sb.AppendLine(($o | ConvertTo-Json -Depth 4 -Compress)) }
                    if ($sb.Length -gt 0) { [System.IO.File]::WriteAllText((Join-Path $session.Dir 'moved-files.jsonl'), $sb.ToString(), (New-Object System.Text.UTF8Encoding($false))) }
                } catch { }
                foreach ($p in $paths) { [void]$state.Selected.Remove([string]$p) }
                Write-Log2 ('已移入隔离区 ' + $r.moved + ' 个 / ' + (Format-Size2 $r.bytes))
                Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; session = $r.session; moved = $r.moved; bytes = $r.bytes; failed = $r.failed; selectedNow = $state.Selected.Count })
            } catch {
                Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = $_.Exception.Message }) -Code 500
            }
            continue
        }

        if ($pathOnly -eq '/api/delete' -and $req.Method -eq 'POST') {
            $confirmed = $false
            if ($bodyObj -ne $null -and ($bodyObj.PSObject.Properties.Name -contains 'confirm')) { $confirmed = [bool]$bodyObj.confirm }
            if (-not $confirmed) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '永久删除必须显式确认（confirm=true）' }) -Code 400; continue }
            $paths = Get-RequestedPaths -Deletable $state.Deletable -JsonBody $bodyObj
            if ($paths.Count -eq 0) { $paths = @($state.Selected) }
            if ($paths.Count -eq 0) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '没有勾选任何文件' }) -Code 400; continue }
            $ok = 0; $bytes = [long]0
            $failed = New-Object System.Collections.ArrayList
            foreach ($p in $paths) {
                try {
                    $sz = [long]((New-Object System.IO.FileInfo($p)).Length)
                    Remove-Item -LiteralPath $p -Force -ErrorAction Stop
                    $ok++; $bytes += $sz
                    [void]$state.Selected.Remove([string]$p)
                } catch { [void]$failed.Add([ordered]@{ path = $p; reason = $_.Exception.Message }) }
            }
            try {
                $session = New-OpSession2 -Root $state.ScanRoot
                $rec = [ordered]@{ op = 'purge-permanent'; ts = (Get-Date).ToString('s'); opId = $session.Id; root = $state.ScanRoot; method = 'permanent-delete'; moved = $ok; bytes = $bytes; failedCount = @($failed).Count; detail = ('永久删除 ' + $ok + ' 个 / ' + (Format-Size2 $bytes) + '，失败 ' + @($failed).Count) }
                Write-OpRecord2 -Root $state.ScanRoot -Record $rec -Kind 'purge' | Out-Null
            } catch { }
            Write-Log2 ('永久删除 ' + $ok + ' 个 / ' + (Format-Size2 $bytes))
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; deleted = $ok; bytes = $bytes; failed = $failed; selectedNow = $state.Selected.Count })
            continue
        }

        if ($pathOnly -eq '/api/quarantine' -and $req.Method -eq 'GET') {
            $root = $state.ScanRoot
            if (-not $root) { $root = [string]$config['defaultPath'] }
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; root = $root; sessions = @(Get-QuarantineSessions2 -ScanRoot $root) })
            continue
        }

        if ($pathOnly -eq '/api/restore' -and $req.Method -eq 'POST') {
            $session = ''
            if ($bodyObj -ne $null -and ($bodyObj.PSObject.Properties.Name -contains 'session')) { $session = [string]$bodyObj.session }
            $qr = $state.ScanRoot
            if (-not $qr) { $qr = [string]$config['defaultPath'] }
            if (-not (Test-QuarantineSessionPath2 -Session $session -ScanRoot $qr)) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = 'session 无效或不在隔离区内，已拒绝' }) -Code 400; continue }
            try { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true; result = (Restore-QuarantineSession2 -Session $session) }) }
            catch { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = $_.Exception.Message }) -Code 500 }
            continue
        }

        if ($pathOnly -eq '/api/purge' -and $req.Method -eq 'POST') {
            $session = ''
            if ($bodyObj -ne $null -and ($bodyObj.PSObject.Properties.Name -contains 'session')) { $session = [string]$bodyObj.session }
            $qr = $state.ScanRoot
            if (-not $qr) { $qr = [string]$config['defaultPath'] }
            if (-not (Test-QuarantineSessionPath2 -Session $session -ScanRoot $qr)) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = 'session 无效或不在隔离区内，已拒绝' }) -Code 400; continue }
            try { [void](Remove-QuarantineSession2 -Session $session); Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true }) }
            catch { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = $_.Exception.Message }) -Code 500 }
            continue
        }

        if ($pathOnly -eq '/api/export') {
            if ($state.Scan -eq $null) { Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '尚未扫描' }) -Code 400; continue }
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('dedup-plan-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.csv')
            [void](Export-DedupPlan2 -Scan $state.Scan -OutFile $tmp)
            $all = [System.IO.File]::ReadAllBytes($tmp)
            try { Remove-Item -LiteralPath $tmp -Force } catch { }
            Write-HttpResponse -Stream $stream -Code 200 -ContentType 'text/csv; charset=utf-8' -Body $all -ExtraHeaders ('Content-Disposition: attachment; filename="dedup-plan.csv"' + (Get-CRLF))
            continue
        }

        if ($pathOnly -eq '/api/stop') {
            Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $true })
            $state.Stop = $true
            continue
        }

        Write-JsonResponse -Stream $stream -Object ([ordered]@{ ok = $false; error = '未知接口' }) -Code 404
    } catch { }
    finally {
        if ($stream -ne $null) { try { $stream.Dispose() } catch { } }
        if ($client -ne $null) { try { $client.Close() } catch { } }
    }
}

try { $listener.Stop() } catch { }
Write-Host '服务已停止。' -ForegroundColor Yellow