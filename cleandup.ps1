# CleanDup 启动器 — 打包为 exe 的入口脚本
# 整合：版本检查 + 服务启动 + 自动打开浏览器

param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 获取脚本真实目录（exe 打包后 $PSScriptRoot 会变化）
$script:AppDir = $PSScriptRoot
if (-not $script:AppDir) { try { $script:AppDir = Split-Path -Parent $PSCommandPath } catch { } }
if (-not $script:AppDir) { try { $script:AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path } catch { } }
if (-not $script:AppDir) { $script:AppDir = (Get-Location).ProviderPath }

# 如果是 exe 运行，AppDir 是 exe 所在目录
# 需要确保 dedup_server.ps1 等文件也在同目录

# 显示启动信息
Write-Host ''
Write-Host '  ==========================================' -ForegroundColor Cyan
Write-Host '   CleanDub — 重复文件清理工具' -ForegroundColor Cyan
Write-Host '  ==========================================' -ForegroundColor Cyan
Write-Host ''

# 读取版本
$version = '0.3.0'
$vf = Join-Path $script:AppDir 'version.json'
if (Test-Path -LiteralPath $vf) {
    try {
        $vj = Get-Content -Raw -LiteralPath $vf -Encoding UTF8 | ConvertFrom-Json
        $version = [string]$vj.version
    } catch { }
}
Write-Host ('  版本: v' + $version) -ForegroundColor Gray
Write-Host ''

# 检查更新（后台，不阻塞启动）
$updateCheckUrl = 'https://api.github.com/repos/XLcode5/CleanDub/releases/latest'
try {
    $resp = Invoke-RestMethod -Uri $updateCheckUrl -TimeoutSec 5 -ErrorAction SilentlyContinue
    $latest = $resp.tag_name -replace '^v', ''
    if ($latest -and $latest -ne $version) {
        Write-Host ('  发现新版本: v' + $latest) -ForegroundColor Yellow
        Write-Host ('  下载: ' + $resp.html_url) -ForegroundColor Gray
        Write-Host ''
    }
} catch { }

# 构建服务器参数
$serverArgs = @{
    Port = $Port
    NoBrowser = $NoBrowser
    SelfTest = $SelfTest
}

# 启动服务器
$serverScript = Join-Path $script:AppDir 'dedup_server.ps1'
if (-not (Test-Path -LiteralPath $serverScript)) {
    Write-Host '错误: 找不到 dedup_server.ps1' -ForegroundColor Red
    Write-Host '请确保所有文件在同一目录' -ForegroundColor Yellow
    pause
    exit 1
}

# 转发参数
& $serverScript @serverArgs
