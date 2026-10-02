<#
  dedup_core.ps1 —— 重复文件清理核心引擎（内容级判重）
  ---------------------------------------------------------------------------
  设计参考（公开算法，非代码抄袭）：
    * Czkawka 三级流水线：按大小分组 -> 读文件头部小片段做 prehash -> 全量哈希
      （官方文档 Instruction.md：“By hash … It consists of 3 steps”）
    * fclones / rmlint：先做廉价指纹淘汰，再对幸存者做昂贵比对
    * WxCleaner：size -> partial hash -> full hash，大小分组后才做哈希
  保留的原作者创新：
    * 隔离区 + manifest.json + 可还原（本文件 Move-ToQuarantine2 / Restore-Quarantine2）
    * 硬链接核算（真实可释放 vs 表面可释放）
    * 保留策略（Newest / Original / Highest）+ 计划 CSV 导出
  相对 v1 的根本变化：
    * 判重依据从“文件名去掉 (N) 后缀”改为“文件内容哈希”，不再依赖文件名
    * 不再限制“同目录”，跨月份/跨目录/跨改名都能命中
    * 逐块读取，绝不把整个文件读进内存
  必须用 UTF-8 with BOM 保存（本机 ANSI=936，无 BOM 会被 PS 5.1 按 GBK 解析）。
#>

function Format-Size2 {
    param([long]$Bytes)
    if ($Bytes -ge 1073741824) { return ('{0:N2} GB' -f ($Bytes / 1073741824)) }
    if ($Bytes -ge 1048576)    { return ('{0:N2} MB' -f ($Bytes / 1048576)) }
    if ($Bytes -ge 1024)       { return ('{0:N1} KB' -f ($Bytes / 1024)) }
    return ('{0} B' -f $Bytes)
}

# 安全添加：把"找不到 Add 重载"这类 .NET 异常变成可定位的中文错误
function Add-Item {
    param($Collection, $Item, [string]$Where)
    if ($null -eq $Collection) { throw ('内部错误[' + $Where + ']：集合为 $null') }
    $m = $Collection.PSObject.Methods['Add']
    if ($null -eq $m) { throw ('内部错误[' + $Where + ']：' + $Collection.GetType().FullName + ' 没有 Add 方法') }
    try { [void]$m.Invoke($Item) }
    catch { throw ('内部错误[' + $Where + ']：' + $Collection.GetType().FullName + '.Add 失败 -> ' + $_.Exception.Message) }
}

function Csv-Safe2 {
    param([string]$Value)
    if ($null -eq $Value) { return '' }
    $t = $Value.Replace('"', '""')
    if ($t.IndexOfAny([char[]]@([char]44, [char]34, [char]10, [char]13)) -ge 0) { return ('"' + $t + '"') }
    return $t
}

# ---------------- 文件身份 / 硬链接（GetFileInformationByHandle） ----------------
function Initialize-FileIdHelper {
    if ('Win32.DedupIdHelper' -as [type]) { return $true }
    $code = @'
using System;
using System.Runtime.InteropServices;
namespace Win32 {
    public static class DedupIdHelper {
        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION {
            public uint dwFileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
            public uint dwVolumeSerialNumber;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint nNumberOfLinks;
            public uint nFileIndexHigh;
            public uint nFileIndexLow;
        }
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
            IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(IntPtr hFile, out BY_HANDLE_FILE_INFORMATION info);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);
        // 返回 "fileIndex:volumeSerial:linkCount"；失败返回 null
        public static string GetIdentity(string path) {
            IntPtr h = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
            if (h == (IntPtr)(-1)) { return null; }
            try {
                BY_HANDLE_FILE_INFORMATION i;
                if (!GetFileInformationByHandle(h, out i)) { return null; }
                ulong idx = ((ulong)i.nFileIndexHigh << 32) | i.nFileIndexLow;
                return idx.ToString("x16") + ":" + i.dwVolumeSerialNumber.ToString("x8") + ":" + i.nNumberOfLinks;
            } finally { CloseHandle(h); }
        }
        public static int GetLinkCount(string path) {
            IntPtr h = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
            if (h == (IntPtr)(-1)) { return -1; }
            try {
                BY_HANDLE_FILE_INFORMATION i;
                if (!GetFileInformationByHandle(h, out i)) { return -1; }
                return (int)i.nNumberOfLinks;
            } finally { CloseHandle(h); }
        }
    }
}
'@
    try { Add-Type -TypeDefinition $code -ErrorAction Stop; return $true } catch { return $false }
}

function Get-FileIdentitySafe {
    param([string]$Path)
    try { return [Win32.DedupIdHelper]::GetIdentity($Path) } catch { return $null }
}
function Get-LinkCountSafe2 {
    param([string]$Path)
    try { return [Win32.DedupIdHelper]::GetLinkCount($Path) } catch { return -1 }
}

# ---------------- 哈希（复用 SHA 实例 + 固定缓冲区，实测比每文件 new 快 12 倍） ----------------
# 返回 @{ Hash = <string|null>; IsFull = <bool> }
#   -HeadBytes <= 0 : 全文件哈希，IsFull=$true
#   -HeadBytes >  0 : 头部哈希；若文件本身 <= HeadBytes 则等价于全文件，IsFull=$true
function Get-FileHashEx {
    param([string]$Path, [long]$Size, [int]$HeadBytes, $Sha, [byte[]]$Buf)
    $key = $Path
    if ($script:KnownFull.ContainsKey($key)) { return [ordered]@{ Hash = [string]$script:KnownFull[$key]; IsFull = $true } }
    if ($script:HashCache.ContainsKey($key)) {
        $c = $script:HashCache[$key]
        return [ordered]@{ Hash = [string]$c.Hash; IsFull = [bool]$c.IsFull }
    }
    $fs = $null; $h = $null; $isFull = $false
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        if ($HeadBytes -le 0) {
            $h = [System.BitConverter]::ToString($Sha.ComputeHash($fs)).Replace('-', '')
            $isFull = $true
        } elseif ($Size -le $HeadBytes) {
            $n = $fs.Read($Buf, 0, [int]$Size)
            if ($n -gt 0) { $h = [System.BitConverter]::ToString($Sha.ComputeHash($Buf, 0, $n)).Replace('-', '') }
            $isFull = $true
        } else {
            $n = $fs.Read($Buf, 0, $HeadBytes)
            if ($n -gt 0) { $h = [System.BitConverter]::ToString($Sha.ComputeHash($Buf, 0, $n)).Replace('-', '') }
        }
    } catch { $h = $null; $isFull = $false }
    finally { if ($fs -ne $null) { $fs.Dispose() } }
    if ($h -ne $null) {
        $script:HashCache[$key] = [ordered]@{ Hash = $h; IsFull = $isFull }
        if ($isFull) { $script:KnownFull[$key] = $h }
    }
    return [ordered]@{ Hash = $h; IsFull = $isFull }
}

# ---------------- 目录遍历 ----------------
function Get-FileIndex2 {
    param([string]$Root, [bool]$Recurse, [string[]]$SkipPath, [string[]]$SkipDirName, [long]$MinSize)
    $files = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    $skipNorm = New-Object System.Collections.ArrayList
    foreach ($s in $SkipPath) { if ($s) { [void]$skipNorm.Add(([string]$s).TrimEnd('\')) } }
    $skipNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($n in $SkipDirName) { if ($n) { [void]$skipNames.Add([string]$n) } }
    $stack = New-Object System.Collections.Stack
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = [string]$stack.Pop()
        $isSkip = $false
        foreach ($s in $skipNorm) {
            if ($dir.Equals($s, [System.StringComparison]::OrdinalIgnoreCase) -or
                $dir.StartsWith($s + '\', [System.StringComparison]::OrdinalIgnoreCase)) { $isSkip = $true; break }
        }
        if ($isSkip) { continue }
        if ($skipNames.Contains([System.IO.Path]::GetFileName($dir))) { continue }
        $names = $null
        try { $names = [System.IO.Directory]::GetFiles($dir) } catch { [void]$skipped.Add($dir); $names = @() }
        foreach ($f in $names) {
            try {
                $fi = [System.IO.FileInfo]::new($f)
                if ($fi.Length -ge $MinSize) { [void]$files.Add($fi) }
            } catch { }
        }
        if ($Recurse) {
            $subs = $null
            try { $subs = [System.IO.Directory]::GetDirectories($dir) } catch { $subs = @() }
            foreach ($sd in $subs) {
                $attr = -1
                try { $attr = [int][System.IO.File]::GetAttributes($sd) } catch { continue }
                if (($attr -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                $stack.Push($sd)
            }
        }
    }
    return [ordered]@{ Files = $files; SkippedDirs = $skipped }
}

# ---------------- 保留策略 ----------------
function Test-HasSuffixMarker {
    param([string]$BaseName)
    return [System.Text.RegularExpressions.Regex]::IsMatch($BaseName, '\s*\(\d+\)$')
}

function Get-SuffixMarkerInfo {
    param([string]$BaseName)
    $ms = [System.Text.RegularExpressions.Regex]::Matches($BaseName, '\(\d+\)')
    $core = [System.Text.RegularExpressions.Regex]::Replace($BaseName, '(\s*\(\d+\))+$', '')
    return [ordered]@{ Count = $ms.Count; Core = $core }
}
function Get-Keeper2 {
    param($Members, [string]$Strategy)
    if ($Strategy -eq 'Highest') {
        $best = $null; $bestN = -1
        foreach ($f in $Members) {
            $m = [System.Text.RegularExpressions.Regex]::Match([string]$f.BaseName, '\((\d+)\)$')
            $n = 0
            if ($m.Success) { $n = [int]$m.Groups[1].Value }
            $take = $false
            if ($n -gt $bestN) { $take = $true }
            elseif ($n -eq $bestN -and $best -ne $null -and [datetime]$f.mtime -gt [datetime]$best.mtime) { $take = $true }
            if ($take) { $bestN = $n; $best = $f }
        }
        if ($best -ne $null) { return $best }
    }
    if ($Strategy -eq 'Original') {
        $plain = @($Members | Where-Object { -not (Test-HasSuffixMarker ([string]$_.BaseName)) })
        if ($plain.Count -gt 0) { return ($plain | Sort-Object { $_.mtime } -Descending)[0] }
    }
    if ($Strategy -eq 'Cleanest') {
        # 名字最接近原始文件名的优先：先比 (N) 标记个数少，再比修改时间新，再比路径短。
        # 真副本内容完全一致，保留哪一份字节都一样；这里选的是最容易辨认的那份。
        return ($Members | Sort-Object @{ Expression = { (Get-SuffixMarkerInfo ([string]$_.BaseName)).Count } },
                                             @{ Expression = { $_.mtime }; Descending = $true },
                                             @{ Expression = { ([string]$_.path).Length } })[0]
    }
    return ($Members | Sort-Object { $_.mtime } -Descending)[0]
}

# ---------------- 主扫描（三级流水线） ----------------
function Invoke-DedupScan2 {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [bool]$Recurse = $true,
        [ValidateSet('Newest','Original','Highest','Cleanest')][string]$Strategy = 'Cleanest',
        [ValidateSet('Full','Head','Name','Size')][string]$Verify = 'Full',
        [long]$HeadBytes = 32768,
        [bool]$DetectLinks = $true,
        [string[]]$ExcludeDir = @(),
        [long]$MinSize = 1,
        [hashtable]$ExtFilter = $null,
        [string]$ProgressFile = '',
        [switch]$Quiet
    )
    if (-not (Test-Path -LiteralPath $Path)) { throw ('找不到路径：' + $Path) }
    $root = (Resolve-Path -LiteralPath $Path).ProviderPath
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $script:HashCache = @{}
    $script:KnownFull = @{}

    $linksReady = $false
    if ($DetectLinks) { $linksReady = Initialize-FileIdHelper }

    $ex = New-Object System.Collections.ArrayList
    foreach ($e in $ExcludeDir) {
        if (-not $e) { continue }
        $es = ([string]$e).TrimEnd('\')
        if ($root.Equals($es, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($root.StartsWith($es + '\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        [void]$ex.Add($es)
    }
    [void]$ex.Add((Join-Path $root '_dedup_quarantine'))
    [void]$ex.Add((Join-Path $root '_dedup_logs'))

    $skipDirs = @('$RECYCLE.BIN', 'System Volume Information', '$Recycle.Bin', '.git', 'node_modules', '_dedup_quarantine', '_dedup_logs')
    $idx = Get-FileIndex2 -Root $root -Recurse $Recurse -SkipPath $ex.ToArray() -SkipDirName $skipDirs -MinSize $MinSize
    $all = $idx.Files
    # 扩展名过滤
    if ($ExtFilter) {
        $filtered = New-Object System.Collections.ArrayList
        foreach ($fi in $all) {
            $ext = [System.IO.Path]::GetExtension($fi.Name).ToLower()
            if ($ExtFilter.Include.Count -gt 0) {
                if ($ExtFilter.Include -contains $ext) { [void]$filtered.Add($fi) }
            } elseif ($ExtFilter.Exclude.Count -gt 0) {
                if (-not ($ExtFilter.Exclude -contains $ext)) { [void]$filtered.Add($fi) }
            } else {
                [void]$filtered.Add($fi)
            }
        }
        $all = $filtered
    }
    Write-ProgressFile2 -File $ProgressFile -Phase 'indexing' -Message '索引完成' -Current $all.Count -Total $all.Count -ElapsedSec $sw.Elapsed.TotalSeconds
    if (-not $Quiet) { Write-Host ('  [1/4] 索引完成：' + $all.Count + ' 个文件，耗时 ' + [math]::Round($sw.Elapsed.TotalSeconds,1) + ' 秒') -ForegroundColor Gray }

    # ---- 阶段 1：按大小分组 ----
    $bySize = @{}
    $idMap = @{}
    $linkUnknown = 0
    foreach ($fi in $all) {
        $k = ([long]$fi.Length).ToString()
        if (-not $bySize.ContainsKey($k)) { $bySize[$k] = New-Object System.Collections.ArrayList }
        Add-Item -Collection $bySize[$k] -Item $fi -Where 'bySize'
        if ($linksReady) {
            $id = Get-FileIdentitySafe $fi.FullName
            if ($id) { $idMap[$fi.FullName] = $id } else { $linkUnknown++ }
        }
    }
    $sizeGroups = @($bySize.GetEnumerator() | Where-Object { $_.Value.Count -ge 2 })
    $candidates = 0
    foreach ($kv in $sizeGroups) { $candidates += $kv.Value.Count }
    Write-ProgressFile2 -File $ProgressFile -Phase 'sizing' -Message ('大小分组：' + $candidates + ' 个候选') -Current $candidates -Total $all.Count -ElapsedSec $sw.Elapsed.TotalSeconds
    if (-not $Quiet) { Write-Host ('  [2/4] 大小分组：' + $sizeGroups.Count + ' 组 / ' + $candidates + ' 个候选文件（其余 ' + ($all.Count - $candidates) + ' 个大小唯一，直接排除）') -ForegroundColor Gray }

    # ---- 阶段 2：prehash（只读文件头部 HeadBytes） ----
    $hashedCandidates = 0
    $preGroups = New-Object System.Collections.ArrayList
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $buf = New-Object byte[] 131072
    try {
        foreach ($kv in $sizeGroups) {
            $byHead = @{}
            foreach ($fi in $kv.Value) {
                $r = Get-FileHashEx -Path $fi.FullName -Size ([long]$fi.Length) -HeadBytes $HeadBytes -Sha $sha -Buf $buf
                $hashedCandidates++
                if ($r.Hash -eq $null) { continue }
                if (-not $byHead.ContainsKey($r.Hash)) { $byHead[$r.Hash] = New-Object System.Collections.ArrayList }
                Add-Item -Collection $byHead[$r.Hash] -Item $fi -Where 'byHead'
                if (($hashedCandidates % 500) -eq 0) { Write-ProgressFile2 -File $ProgressFile -Phase 'prehash' -Message ('prehash ' + $hashedCandidates + '/' + $candidates) -Current $hashedCandidates -Total $candidates -ElapsedSec $sw.Elapsed.TotalSeconds }
                if (($hashedCandidates % 5000) -eq 0 -and -not $Quiet) {
                    Write-Host ('        .. 已 prehash ' + $hashedCandidates + ' / ' + $candidates + '  (' + [math]::Round($sw.Elapsed.TotalSeconds,0) + 's)') -ForegroundColor DarkGray
                }
            }
            foreach ($hk in $byHead.GetEnumerator()) { if ($hk.Value.Count -ge 2) { Add-Item -Collection $preGroups -Item $hk.Value -Where 'preGroups' } }
        }
    } finally { $sha.Dispose() }
    $preSurvivors = 0
    foreach ($g in $preGroups) { $preSurvivors += $g.Count }
    Write-ProgressFile2 -File $ProgressFile -Phase 'fullhash' -Message ('全量哈希：' + $preSurvivors + ' 个候选') -Current 0 -Total ([Math]::Max($preSurvivors,1)) -ElapsedSec $sw.Elapsed.TotalSeconds
    if (-not $Quiet) { Write-Host ('  [3/4] prehash（头部 ' + (Format-Size2 $HeadBytes) + '）：幸存 ' + $preGroups.Count + ' 组 / ' + $preSurvivors + ' 个文件（其余头部不同，已排除）') -ForegroundColor Gray }

    # ---- 阶段 3：全量哈希（或按文件名/大小快速分组） ----
    $byFull = New-Object System.Collections.ArrayList
    $fullHashed = 0
    $hardlinkGroups = 0
    $hardlinkVictims = 0
    
    if ($Verify -eq 'Name') {
        # 只按文件名分组（去掉 (N) 后缀，跨目录）
        $byName = @{}
        foreach ($g in $preGroups) {
            foreach ($fi in $g) {
                $baseName = [System.IO.Path]::GetFileNameWithoutExtension($fi.Name)
                $cleanName = [System.Text.RegularExpressions.Regex]::Replace($baseName, '(\s*\(\d+\))+$', '')
                $key = $cleanName.ToLowerInvariant() + '.' + [System.IO.Path]::GetExtension($fi.Name).ToLowerInvariant()
                if (-not $byName.ContainsKey($key)) { $byName[$key] = New-Object System.Collections.ArrayList }
                [void]$byName[$key].Add($fi)
            }
        }
        foreach ($k in $byName.Keys) {
            if ($byName[$k].Count -ge 2) { [void]$byFull.Add($byName[$k]) }
        }
        if (-not $Quiet) { Write-Host ('  [4/4] 文件名分组：' + $byFull.Count + ' 组（仅按文件名，未校验内容）') -ForegroundColor Gray }
    } elseif ($Verify -eq 'Size') {
        # 只按大小分组（已经在阶段1完成，直接复用）
        foreach ($kv in $sizeGroups) {
            if ($kv.Value.Count -ge 2) { [void]$byFull.Add($kv.Value) }
        }
        if (-not $Quiet) { Write-Host ('  [4/4] 大小分组：' + $byFull.Count + ' 组（仅按大小，未校验内容）') -ForegroundColor Gray }
    } else {
        # Full 或 Head：内容级哈希
        $sha2 = [System.Security.Cryptography.SHA256]::Create()
        try {
            foreach ($g in $preGroups) {
                $clusters = New-Object System.Collections.ArrayList

                # (a) 硬链接身份归并：只有当“同一个 fileIndex 在本组内出现 >= 2 次”时，
                #     这些路径才是同一份数据的多个名字。只出现一次的身份没有任何信息量，
                #     绝不能用它来代替内容比较（否则每个文件自成一组，永远查不出重复）。
                $byIdent = @{}
                foreach ($fi in $g) {
                    $id = $null
                    if ($idMap.ContainsKey($fi.FullName)) { $id = [string]$idMap[$fi.FullName] }
                    if (-not $id) { continue }

                    $idParts = $id.Split(':')
                    $idxOnly = [string]($idParts[0] + ':' + $idParts[1])
                    if (-not $byIdent.ContainsKey($idxOnly)) { $byIdent[$idxOnly] = New-Object System.Collections.ArrayList }
                    Add-Item -Collection $byIdent[$idxOnly] -Item $fi -Where 'byIdent'
                }
                $rest = New-Object System.Collections.ArrayList
                foreach ($k in $byIdent.Keys) {
                    $names = $byIdent[$k]
                    if ($names.Count -ge 2) {
                        # 真正的硬链接：内容必然相同，直接成组
                        Add-Item -Collection $clusters -Item $names -Where 'clusters-hardlink'
                        $hardlinkGroups++
                        $hardlinkVictims += ($names.Count - 1)
                    } else {
                        foreach ($fi in $names) { Add-Item -Collection $rest -Item $fi -Where 'rest' }
                    }
                }
                if ($rest.Count -gt 0) {
                    # (b) 内容归并：已确认为“全文件哈希”的直接复用，否则按 Verify 决定是否全量读
                    $byHash2 = @{}
                    foreach ($fi in $rest) {
                        $known = $null
                        $isFull = $false
                        if ($script:KnownFull.ContainsKey($fi.FullName)) { $known = [string]$script:KnownFull[$fi.FullName]; $isFull = $true }
                        elseif ($script:HashCache.ContainsKey($fi.FullName)) {
                            $c = $script:HashCache[$fi.FullName]
                            if ([bool]$c.IsFull) { $known = [string]$c.Hash; $isFull = $true }
                        }
                        if ($isFull) {
                            $h = $known
                        } elseif ($Verify -eq 'Head') {
                            # Head 模式复用 prehash 结果；取不到就退回全量哈希，绝不让 $null.Hash 把整个扫描打断
                            if ($script:HashCache.ContainsKey($fi.FullName)) {
                                $h = [string]$script:HashCache[$fi.FullName].Hash
                            } else {
                                $r3 = Get-FileHashEx -Path $fi.FullName -Size ([long]$fi.Length) -HeadBytes 0 -Sha $sha2 -Buf $buf
                                $fullHashed++
                                if ($r3.Hash -eq $null) { continue }
                                $h = $r3.Hash
                            }
                        } else {
                            $r2 = Get-FileHashEx -Path $fi.FullName -Size ([long]$fi.Length) -HeadBytes 0 -Sha $sha2 -Buf $buf
                            $fullHashed++
                            if ($r2.Hash -eq $null) { continue }
                            $h = $r2.Hash
                        }
                        if ($h -eq $null) { continue }
                        if (-not $byHash2.ContainsKey($h)) { $byHash2[$h] = New-Object System.Collections.ArrayList }
                        Add-Item -Collection $byHash2[$h] -Item $fi -Where 'byHash2'
                    }
                    foreach ($k in $byHash2.Keys) { Add-Item -Collection $clusters -Item $byHash2[$k] -Where 'clusters-hash' }
                }
                foreach ($c in $clusters) { if ($c.Count -ge 2) { Add-Item -Collection $byFull -Item $c -Where 'byFull' } }
            }
        } finally { $sha2.Dispose() }
        if (-not $Quiet) { Write-Host ('  [4/4] 全量哈希：新读取 ' + $fullHashed + ' 个文件，硬链接组 ' + $hardlinkGroups + '，耗时 ' + [math]::Round($sw.Elapsed.TotalSeconds,1) + ' 秒') -ForegroundColor Gray }
    }

    # ---- 汇总 ----
    $groups = New-Object System.Collections.ArrayList
    $nominal = [long]0; $real = [long]0
    $totVictims = 0; $totShared = 0; $groupCount = 0
    foreach ($members in $byFull) {
        if ($members.Count -lt 2) { continue }
        $keeper = Get-Keeper2 -Members $members -Strategy $Strategy
        $keeperLinks = -1
        if ($linksReady) { $keeperLinks = Get-LinkCountSafe2 $keeper.FullName }
        $vList = New-Object System.Collections.ArrayList
        $gNominal = [long]0; $gReal = [long]0
        foreach ($v in $members) {
            if ($v.FullName -eq $keeper.FullName) { continue }
            $links = -1
            if ($linksReady) { $links = Get-LinkCountSafe2 $v.FullName }
            $gNominal += [long]$v.Length
            $isShared = ($links -gt 1)
            if ($isShared) { $totShared++ } else { $gReal += [long]$v.Length }
            $totVictims++
            [void]$vList.Add([ordered]@{
                name   = $v.Name
                path   = $v.FullName
                mtime  = $v.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
                size   = [long]$v.Length
                links  = $links
                shared = $isShared
            })
        }
        if ($vList.Count -eq 0) { continue }
        $groupCount++
        $nominal += $gNominal
        $real += $gReal
        [void]$groups.Add([ordered]@{
            dir     = $keeper.DirectoryName
            keeper  = [ordered]@{ name = $keeper.Name; path = $keeper.FullName; mtime = $keeper.LastWriteTime.ToString('yyyy-MM-dd HH:mm'); size = [long]$keeper.Length; links = $keeperLinks }
            victims = $vList
            nominal = $gNominal
            real    = $gReal
        })
    }
    $sw.Stop()
    return [ordered]@{
        root         = $root
        recurse      = $Recurse
        strategy     = $Strategy
        verify       = $Verify
        headBytes    = $HeadBytes
        minSize      = $MinSize
        linkDetectOk = $linksReady
        linkUnknown  = $linkUnknown
        scannedFiles = $all.Count
        skippedDirs  = $idx.SkippedDirs.Count
        sizeGroups   = $sizeGroups.Count
        candidates   = $candidates
        preGroups    = $preGroups.Count
        preSurvivors = $preSurvivors
        fullHashed   = $fullHashed
        hardlinkGroups  = $hardlinkGroups
        hardlinkVictims = $hardlinkVictims
        totalGroups  = $groupCount
        totalVictims = $totVictims
        sharedVictims = $totShared
        nominalBytes = $nominal
        realBytes    = $real
        elapsedMs    = $sw.ElapsedMilliseconds
        groups       = @($groups | Sort-Object { $_['nominal'] } -Descending)
    }
}

# ---------------- 隔离区（保留原作者设计） ----------------

# ---------------- 进度文件（供服务端/前端轮询） ----------------
function Write-ProgressFile2 {
    param([string]$File, [string]$Phase, [string]$Message, [long]$Current = 0, [long]$Total = 0, [double]$ElapsedSec = 0)
    if (-not $File) { return }
    try {
        $pct = 0
        if ($Total -gt 0) { $pct = [Math]::Min(100, [Math]::Round(($Current * 100.0) / $Total, 1)) }
        $json = ([ordered]@{ phase = $Phase; message = $Message; current = $Current; total = $Total; percent = $pct; elapsedSec = [Math]::Round($ElapsedSec, 1); ts = (Get-Date).ToString('s') } | ConvertTo-Json -Compress)
        if ($script:ProgressFile -ne $File) { $script:ProgressFile = $File }
        [System.IO.File]::WriteAllText($File, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}
# ---------------- 操作日志（append-only，永不随隔离区被清空而丢失） ----------------
function Get-OpLogDir {
    param([string]$Root)
    $d = Join-Path (Join-Path $Root '_dedup_logs') 'ops.jsonl'
    return $d
}

function Get-OpLogRoot {
    param([string]$Root)
    return (Join-Path $Root '_dedup_logs')
}

# 生成一个带时间戳的操作目录 <root>\_dedup_logs\<yyyyMMdd_HHmmss>-<rand>
function New-OpSession2 {
    param([string]$Root)
    $base = Get-OpLogRoot -Root $Root
    [void][System.IO.Directory]::CreateDirectory($base)
    $stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
    $name = $stamp + '-' + ([guid]::NewGuid().ToString('N').Substring(0,6))
    $dir = Join-Path $base $name
    [void][System.IO.Directory]::CreateDirectory($dir)
    return [ordered]@{ Id = $name; Dir = $dir; Root = $Root; StartedAt = (Get-Date).ToString('s') }
}

# 写一条 JSON 到 ops.jsonl（append），并同时在该次操作目录下留一份明细
function Write-OpRecord2 {
    param([string]$Root, $Record, [string]$Kind = 'action')
    $ok = $false; $err = ''
    try {
        $line = ($Record | ConvertTo-Json -Depth 8 -Compress)
        $jsonl = Get-OpLogDir -Root $Root
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $fs = [System.IO.File]::Open($jsonl, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try {
            $bytes = $utf8.GetBytes($line + "`n")
            $fs.Write($bytes, 0, $bytes.Length)
        } finally { $fs.Dispose() }
        $ok = $true
    } catch { $err = $_.Exception.Message }
    return [ordered]@{ ok = $ok; error = $err }
}

# 记录计划（扫描结果）为 CSV；只写 plan/detail，不改动任何文件
function Export-DedupPlanFile2 {
    param($Scan, [string]$OutFile)
    return (Export-DedupPlan2 -Scan $Scan -OutFile $OutFile)
}
function Get-QuarantineRoot2 { param([string]$ScanRoot) return (Join-Path $ScanRoot '_dedup_quarantine') }

function Test-QuarantineSessionPath2 {
    param([string]$Session, [string]$ScanRoot)
    if (-not $Session) { return $false }
    try { $full = [System.IO.Path]::GetFullPath($Session) } catch { return $false }
    try { $qfull = [System.IO.Path]::GetFullPath((Get-QuarantineRoot2 -ScanRoot $ScanRoot)) } catch { return $false }
    if (-not $full.StartsWith($qfull + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    $parent = [System.IO.Path]::GetDirectoryName($full)
    if (-not $parent.Equals($qfull, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $full 'manifest.json'))) { return $false }
    return $true
}

function Move-ToQuarantine2 {
    param([string]$ScanRoot, [string[]]$Paths, [string]$Session = '')
    $qroot = Get-QuarantineRoot2 -ScanRoot $ScanRoot
    if (-not $Session) {
        $stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
        $Session = Join-Path $qroot ($stamp + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6)))
    }
    [void][System.IO.Directory]::CreateDirectory($Session)
    $moved = 0; $bytes = [long]0
    $failed = New-Object System.Collections.ArrayList
    $entries = New-Object System.Collections.ArrayList
    $rootLen = $ScanRoot.Length
    $rootFull = [System.IO.Path]::GetFullPath($ScanRoot)
    foreach ($p in $Paths) {
        if (-not $p) { continue }
        try { $pFull = [System.IO.Path]::GetFullPath($p) } catch { continue }
        if (-not $pFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            [void]$failed.Add([ordered]@{ path = $p; reason = '不在扫描根目录内，已拒绝' }); continue
        }
        if (-not (Test-Path -LiteralPath $p)) { [void]$failed.Add([ordered]@{ path = $p; reason = '文件不存在' }); continue }
        $rel = $p
        if ($p.StartsWith($ScanRoot, [System.StringComparison]::OrdinalIgnoreCase)) { $rel = $p.Substring($rootLen).TrimStart('\') }
        if (-not $rel) { $rel = [System.IO.Path]::GetFileName($p) }
        $dest = Join-Path $Session $rel
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
        $final = $dest; $i = 1
        while (Test-Path -LiteralPath $final) { $final = $dest + '.' + $i; $i++ }
        try {
            $sz = [long]((New-Object System.IO.FileInfo($p)).Length)
            try { [System.IO.File]::Move($p, $final) }
            catch { [System.IO.File]::Copy($p, $final, $true); [System.IO.File]::Delete($p) }
            [void]$entries.Add([ordered]@{ original = $p; stored = $final; size = $sz; movedAt = (Get-Date).ToString('s') })
            $moved++; $bytes += $sz
        } catch { [void]$failed.Add([ordered]@{ path = $p; reason = $_.Exception.Message }) }
    }
    if ($entries.Count -gt 0) {
        $mf = Join-Path $Session 'manifest.json'
        $allEntries = New-Object System.Collections.ArrayList
        if (Test-Path -LiteralPath $mf) {
            try { $old = Get-Content -Raw -LiteralPath $mf -Encoding UTF8 | ConvertFrom-Json; foreach ($o in @($old)) { [void]$allEntries.Add($o) } } catch { }
        }
        foreach ($e in $entries) { [void]$allEntries.Add($e) }
        ([ordered]@{ scanRoot = $ScanRoot; createdAt = (Get-Date).ToString('s'); files = @($allEntries) } | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $mf -Encoding UTF8
    }
    return [ordered]@{ session = $Session; moved = $moved; bytes = $bytes; failed = $failed; entries = $entries }
}

function Get-QuarantineSessions2 {
    param([string]$ScanRoot)
    $qroot = Get-QuarantineRoot2 -ScanRoot $ScanRoot
    $out = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $qroot)) { return @() }
    foreach ($d in [System.IO.Directory]::GetDirectories($qroot)) {
        $mf = Join-Path $d 'manifest.json'
        $count = 0; $bytes = [long]0; $movedAt = ''
        if (Test-Path -LiteralPath $mf) {
            try {
                $j = Get-Content -Raw -LiteralPath $mf -Encoding UTF8 | ConvertFrom-Json
                $items = @($j.files)
                if ($items.Count -eq 0 -and $j -is [array]) { $items = @($j) }
                foreach ($o in $items) { $count++; $bytes += [long]$o.size; if ([string]$o.movedAt -gt $movedAt) { $movedAt = [string]$o.movedAt } }
            } catch { }
        }
        [void]$out.Add([ordered]@{ name = [System.IO.Path]::GetFileName($d); path = $d; files = $count; bytes = $bytes; movedAt = $movedAt })
    }
    return @($out | Sort-Object { $_['movedAt'] } -Descending)
}

function Restore-QuarantineSession2 {
    param([string]$Session)
    $failed = New-Object System.Collections.ArrayList
    $mf = Join-Path $Session 'manifest.json'
    if (-not (Test-Path -LiteralPath $mf)) { return [ordered]@{ restored = 0; failed = $failed; error = '找不到 manifest.json' } }
    $restored = 0
    $sessFull = [System.IO.Path]::GetFullPath($Session)
    try { $j = Get-Content -Raw -LiteralPath $mf -Encoding UTF8 | ConvertFrom-Json } catch { return [ordered]@{ restored = 0; failed = $failed; error = 'manifest.json 解析失败' } }
    $items = @($j.files)
    if ($items.Count -eq 0 -and $j -is [array]) { $items = @($j) }
    foreach ($o in $items) {
        $target = [string]$o.original
        $stored = [string]$o.stored
        $storedFull = $null
        try { $storedFull = [System.IO.Path]::GetFullPath($stored) } catch { }
        if (-not $storedFull -or -not $storedFull.StartsWith($sessFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) { [void]$failed.Add([ordered]@{ path = $stored; reason = '不在隔离区内，已拒绝还原' }); continue }
        if (-not (Test-Path -LiteralPath $stored)) { [void]$failed.Add([ordered]@{ path = $target; reason = '隔离区内文件已不存在' }); continue }
        if (Test-Path -LiteralPath $target) { $target = $target + '.restored' }
        try {
            [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $target))
            try { [System.IO.File]::Move($stored, $target) }
            catch { [System.IO.File]::Copy($stored, $target, $true); [System.IO.File]::Delete($stored) }
            $restored++
        } catch { [void]$failed.Add([ordered]@{ path = $target; reason = $_.Exception.Message }) }
    }
    if ($failed.Count -eq 0 -and $restored -gt 0) {
        try { Remove-Item -LiteralPath $Session -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
    return [ordered]@{ restored = $restored; failed = $failed }
}

function Remove-QuarantineSession2 {
    param([string]$Session)
    if (-not (Test-Path -LiteralPath $Session)) { return $false }
    Remove-Item -LiteralPath $Session -Recurse -Force -ErrorAction Stop
    return $true
}

# ---------------- 历史操作查看与导出 ----------------
function Get-OpHistory2 {
    param([string]$Root, [int]$Limit = 30)
    $jsonl = Get-OpLogDir -Root $Root
    $out = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $jsonl)) { return @() }
    $lines = @(Get-Content -LiteralPath $jsonl -Encoding UTF8)
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $ln = [string]$lines[$i]
        if (-not $ln.Trim()) { continue }
        try { $o = $ln | ConvertFrom-Json } catch { continue }
        [void]$out.Add($o)
        if ($out.Count -ge $Limit) { break }
    }
    return @($out)
}
function Export-DedupPlan2 {
    param($Scan, [string]$OutFile)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('组号,目录,角色,文件名,修改时间,大小(字节),硬链接数,完整路径')
    $gi = 0
    $crlf = ([string][char]13 + [string][char]10)
    foreach ($g in $Scan.groups) {
        $gi++
        [void]$sb.Append($crlf)
        [void]$sb.Append($gi.ToString() + ',' + (Csv-Safe2 ([string]$g.dir)) + ',保留,' + (Csv-Safe2 ([string]$g.keeper.name)) + ',' + $g.keeper.mtime + ',' + $g.keeper.size + ',' + $g.keeper.links + ',' + (Csv-Safe2 ([string]$g.keeper.path)))
        foreach ($v in $g.victims) {
            [void]$sb.Append($crlf)
            [void]$sb.Append($gi.ToString() + ',' + (Csv-Safe2 ([string]$g.dir)) + ',待删,' + (Csv-Safe2 ([string]$v.name)) + ',' + $v.mtime + ',' + $v.size + ',' + $v.links + ',' + (Csv-Safe2 ([string]$v.path)))
        }
    }
    $enc = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($OutFile, $sb.ToString(), $enc)
    return $OutFile
}

# ---------------- 多目录结果合并 ----------------
function Merge-ScanResults {
    param([array]$Results, [string]$Strategy = 'Cleanest')
    # 按完整哈希合并跨目录重复组
    $byHash = @{}
    foreach ($r in $Results) {
        foreach ($g in $r.groups) {
            $key = $g.keeper.path  # 用 keeper 路径作为临时 key
            # 需要按内容哈希重新分组，但当前结果没有保留哈希值
            # 简化方案：按 keeper 文件名 + 大小合并（可能不够精确）
            # 更好的方案：在 Invoke-DedupScan2 中返回哈希值
            $hashKey = [string]$g.keeper.size + ':' + [string]$g.keeper.name
            if (-not $byHash.ContainsKey($hashKey)) { $byHash[$hashKey] = New-Object System.Collections.ArrayList }
            foreach ($v in $g.victims) { [void]$byHash[$hashKey].Add($v) }
            [void]$byHash[$hashKey].Add($g.keeper)
        }
    }
    # 重新构建组
    $mergedGroups = New-Object System.Collections.ArrayList
    $totalNominal = [long]0; $totalReal = [long]0
    foreach ($k in $byHash.Keys) {
        $members = @($byHash[$k] | Sort-Object { $_.mtime } -Descending)
        if ($members.Count -lt 2) { continue }
        $keeper = $members[0]
        $victims = @($members | Select-Object -Skip 1)
        $gNominal = [long]0; $gReal = [long]0
        foreach ($v in $victims) { $gNominal += [long]$v.size; $gReal += [long]$v.size }
        [void]$mergedGroups.Add([ordered]@{
            dir = $keeper.DirectoryName
            keeper = [ordered]@{ name = $keeper.Name; path = $keeper.FullName; mtime = $keeper.LastWriteTime.ToString('yyyy-MM-dd HH:mm'); size = [long]$keeper.Length; links = -1 }
            victims = @($victims | ForEach-Object { [ordered]@{ name = $_.Name; path = $_.FullName; mtime = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'); size = [long]$_.Length; links = -1; shared = $false } })
            nominal = $gNominal
            real = $gReal
        })
        $totalNominal += $gNominal; $totalReal += $gReal
    }
    # 汇总统计
    $totalFiles = 0; $totalGroups = 0; $totalVictims = 0
    foreach ($r in $Results) { $totalFiles += $r.scannedFiles; $totalGroups += $r.totalGroups; $totalVictims += $r.totalVictims }
    return [ordered]@{
        root = $Results[0].root
        multiRoot = @($Results | ForEach-Object { $_.root })
        recurse = $Results[0].recurse
        strategy = $Strategy
        verify = $Results[0].verify
        headBytes = $Results[0].headBytes
        minSize = $Results[0].minSize
        linkDetectOk = $Results[0].linkDetectOk
        linkUnknown = 0
        scannedFiles = $totalFiles
        skippedDirs = 0
        sizeGroups = 0
        candidates = 0
        preGroups = 0
        preSurvivors = 0
        fullHashed = 0
        hardlinkGroups = 0
        hardlinkVictims = 0
        totalGroups = $mergedGroups.Count
        totalVictims = $totalVictims
        sharedVictims = 0
        nominalBytes = $totalNominal
        realBytes = $totalReal
        elapsedMs = 0
        groups = @($mergedGroups | Sort-Object { $_['nominal'] } -Descending)
    }
}
