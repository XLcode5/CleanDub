# Cleandup 功能管理工具
# 自动生成版本功能清单（HTML + CSV）

param(
    [string]$OutputDir = ".\docs",
    [string]$Version = ""
)

# 如果没有指定版本，从 git 获取
if (-not $Version) {
    try {
        $gitTag = git describe --tags --abbrev=0 2>$null
        if ($gitTag) { $Version = $gitTag } else { $Version = "v0.3.0-dev" }
    } catch { $Version = "v0.3.0-dev" }
}

# 功能清单数据结构
$features = @(
    # 核心引擎
    @{ Category = "核心引擎"; Name = "内容级判重"; Status = "已完成"; Version = "v0.1.0"; Description = "SHA-256 全量哈希，跨目录/跨改名/多层 (N) 后缀命中"; Priority = "P0"; Notes = "三级流水线：大小分组 → prehash → 全量" },
    @{ Category = "核心引擎"; Name = "预筛强度"; Status = "已完成"; Version = "v0.2.0"; Description = "16/32/64/128 KB 四档预筛片段，平衡速度与精度"; Priority = "P0"; Notes = "原「头部大小」，已更名" },
    @{ Category = "核心引擎"; Name = "扫描方式"; Status = "已完成"; Version = "v0.3.0"; Description = "全量哈希 / 只比头部 / 只比文件名 / 只比文件大小"; Priority = "P0"; Notes = "新增 Name 和 Size 模式" },
    @{ Category = "核心引擎"; Name = "保留策略"; Status = "已完成"; Version = "v0.1.0"; Description = "Cleanest / Newest / Original / Highest 四种策略"; Priority = "P0"; Notes = "默认 Cleanest" },
    @{ Category = "核心引擎"; Name = "硬链接检测"; Status = "已完成"; Version = "v0.1.0"; Description = "识别硬链接，区分表面/真实可释放空间"; Priority = "P1"; Notes = "需要 Windows API" },
    @{ Category = "核心引擎"; Name = "多目录扫描"; Status = "已完成"; Version = "v0.2.0"; Description = "支持分号分隔多个路径，合并结果"; Priority = "P1"; Notes = "CLI 参数 -Paths" },
    @{ Category = "核心引擎"; Name = "文件类型过滤"; Status = "已完成"; Version = "v0.2.0"; Description = "IncludeExt / ExcludeExt 参数控制"; Priority = "P1"; Notes = "UI 已暴露" },
    @{ Category = "核心引擎"; Name = "最小文件大小"; Status = "已完成"; Version = "v0.2.0"; Description = "MinSize 参数，UI 下拉选择"; Priority = "P2"; Notes = "1KB-1MB 五档" },
    
    # 安全与恢复
    @{ Category = "安全与恢复"; Name = "隔离区"; Status = "已完成"; Version = "v0.1.0"; Description = "移入隔离区而非直接删除，保留 manifest"; Priority = "P0"; Notes = "默认动作" },
    @{ Category = "安全与恢复"; Name = "一键还原"; Status = "已完成"; Version = "v0.1.0"; Description = "从隔离区恢复全部或选中文件"; Priority = "P0"; Notes = "网页/CLI 都支持" },
    @{ Category = "安全与恢复"; Name = "永久删除"; Status = "已完成"; Version = "v0.1.0"; Description = "需二次确认，直接删除文件"; Priority = "P0"; Notes = "高危操作" },
    @{ Category = "安全与恢复"; Name = "操作日志"; Status = "已完成"; Version = "v0.2.0"; Description = "ops.jsonl append-only，永不丢失"; Priority = "P1"; Notes = "独立于隔离区" },
    @{ Category = "安全与恢复"; Name = "扫描终止"; Status = "已完成"; Version = "v0.3.0"; Description = "后台任务可中断，开始新任务"; Priority = "P1"; Notes = "新增 /api/stop-scan" },
    
    # 用户界面
    @{ Category = "用户界面"; Name = "网页界面"; Status = "已完成"; Version = "v0.1.0"; Description = "本地 TcpListener 服务，免管理员"; Priority = "P0"; Notes = "127.0.0.1  only" },
    @{ Category = "用户界面"; Name = "深色/浅色主题"; Status = "已完成"; Version = "v0.3.0"; Description = "localStorage 记忆用户偏好"; Priority = "P2"; Notes = "新增" },
    @{ Category = "用户界面"; Name = "响应式布局"; Status = "已完成"; Version = "v0.3.0"; Description = "适配小窗口和移动端"; Priority = "P2"; Notes = "新增" },
    @{ Category = "用户界面"; Name = "目录浏览"; Status = "已完成"; Version = "v0.3.0"; Description = "模态框浏览本机目录，支持下钻"; Priority = "P1"; Notes = "新增 /api/browse" },
    @{ Category = "用户界面"; Name = "文件类型筛选"; Status = "已完成"; Version = "v0.3.0"; Description = "图片/视频/音频/文档/压缩包快捷筛选"; Priority = "P1"; Notes = "新增" },
    @{ Category = "用户界面"; Name = "进度显示"; Status = "已完成"; Version = "v0.2.0"; Description = "阶段进度 + 百分比 + 已用时间"; Priority = "P1"; Notes = "后台轮询" },
    @{ Category = "用户界面"; Name = "分页浏览"; Status = "已完成"; Version = "v0.1.0"; Description = "每页 50 组，服务端分页"; Priority = "P1"; Notes = "避免 DOM 爆炸" },
    @{ Category = "用户界面"; Name = "统计卡片"; Status = "已完成"; Version = "v0.2.0"; Description = "重复组/待清理/可释放/耗时等"; Priority = "P1"; Notes = "实时更新" },
    
    # 输出与集成
    @{ Category = "输出与集成"; Name = "CSV 导出"; Status = "已完成"; Version = "v0.1.0"; Description = "清理计划导出，含完整路径"; Priority = "P1"; Notes = "Excel 兼容" },
    @{ Category = "输出与集成"; Name = "命令行版"; Status = "已完成"; Version = "v0.1.0"; Description = "dedup.ps1 全功能 CLI"; Priority = "P1"; Notes = "适合脚本化" },
    @{ Category = "输出与集成"; Name = "一键启动器"; Status = "已完成"; Version = "v0.1.0"; Description = "清理重复文件.bat 双击即用"; Priority = "P1"; Notes = "自动选端口+开浏览器" },
    
    # 规划中的功能
    @{ Category = "规划功能"; Name = "JSON 导出"; Status = "规划中"; Version = "v0.4.0"; Description = "扫描结果导出为 JSON"; Priority = "P2"; Notes = "API 已有数据" },
    @{ Category = "规划功能"; Name = "文件预览"; Status = "规划中"; Version = "v0.4.0"; Description = "图片缩略图、文本前 N 行预览"; Priority = "P2"; Notes = "需要文件类型检测" },
    @{ Category = "规划功能"; Name = "表格排序"; Status = "规划中"; Version = "v0.4.0"; Description = "按大小/日期/组数排序"; Priority = "P2"; Notes = "前端实现" },
    @{ Category = "规划功能"; Name = "历史记录"; Status = "规划中"; Version = "v0.4.0"; Description = "扫描历史列表，快速对比"; Priority = "P2"; Notes = "读取 _dedup_logs" },
    @{ Category = "规划功能"; Name = "exe 打包"; Status = "进行中"; Version = "v0.4.0"; Description = "ps2exe 单文件可执行程序"; Priority = "P1"; Notes = "当前阶段" },
    @{ Category = "规划功能"; Name = "自动更新"; Status = "规划中"; Version = "v0.5.0"; Description = "检查 GitHub Release 更新"; Priority = "P3"; Notes = "需要版本 API" },
    @{ Category = "规划功能"; Name = "多语言"; Status = "规划中"; Version = "v0.5.0"; Description = "中英文切换"; Priority = "P3"; Notes = "i18n 框架" },
    @{ Category = "规划功能"; Name = "云存储支持"; Status = "规划中"; Version = "v0.6.0"; Description = "OneDrive/百度网盘占位符识别"; Priority = "P3"; Notes = "需要云 API" }
)

# 生成 CSV
$csvPath = Join-Path $OutputDir "features-$Version.csv"
$csvData = $features | ForEach-Object {
    [PSCustomObject]@{
        Category = $_.Category
        Name = $_.Name
        Status = $_.Status
        Version = $_.Version
        Priority = $_.Priority
        Description = $_.Description
        Notes = $_.Notes
    }
}
$csvData | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
Write-Host "CSV 已生成: $csvPath" -ForegroundColor Green

# 生成 HTML
$htmlPath = Join-Path $OutputDir "features-$Version.html"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# 统计
$total = $features.Count
$done = @($features | Where-Object { $_.Status -eq "已完成" }).Count
$doing = @($features | Where-Object { $_.Status -eq "进行中" }).Count
$plan = @($features | Where-Object { $_.Status -eq "规划中" }).Count

$categories = @($features | Group-Object Category | Sort-Object Name)

$html = @"
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cleandup 功能清单 - $Version</title>
<style>
:root{--bg:#0f172a;--bg-card:#1e293b;--bg-hover:#334155;--border:#334155;--text:#f1f5f9;--text-secondary:#94a3b8;--accent:#3b82f6;--success:#10b981;--warning:#f59e0b;--danger:#ef4444;--purple:#8b5cf6}
[data-theme="light"]{--bg:#f1f5f9;--bg-card:#fff;--bg-hover:#e2e8f0;--border:#cbd5e1;--text:#1e293b;--text-secondary:#64748b;--accent:#2563eb}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px}
.container{max-width:1200px;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:16px}
h1{font-size:28px;display:flex;align-items:center;gap:12px}
.version-tag{background:var(--accent);color:#fff;padding:4px 12px;border-radius:20px;font-size:14px;font-weight:600}
.meta{color:var(--text-secondary);font-size:14px}
.stats{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 24px;text-align:center;min-width:120px}
.stat .num{font-size:32px;font-weight:700;margin-bottom:4px}
.stat .label{font-size:13px;color:var(--text-secondary)}
.stat.done .num{color:var(--success)}
.stat.doing .num{color:var(--warning)}
.stat.plan .num{color:var(--purple)}
.filters{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.filter-btn{background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;transition:all .2s}
.filter-btn:hover{background:var(--bg-hover)}
.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.category{margin-bottom:24px}
.category-header{display:flex;align-items:center;gap:10px;margin-bottom:12px;cursor:pointer;user-select:none}
.category-header h2{font-size:18px;font-weight:600}
.category-header .count{background:var(--bg-hover);color:var(--text-secondary);padding:2px 10px;border-radius:12px;font-size:12px}
.category-header .arrow{transition:transform .2s}
.category.collapsed .arrow{transform:rotate(-90deg)}
.category.collapsed .feature-list{display:none}
.feature-list{display:grid;gap:8px}
.feature{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 18px;display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;transition:all .2s}
.feature:hover{border-color:var(--accent)}
.feature .status{width:80px;text-align:center;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:600}
.feature .status.done{background:rgba(16,185,129,.2);color:var(--success)}
.feature .status.doing{background:rgba(245,158,11,.2);color:var(--warning)}
.feature .status.plan{background:rgba(139,92,246,.2);color:var(--purple)}
.feature .name{font-weight:600;font-size:15px}
.feature .desc{color:var(--text-secondary);font-size:13px;margin-top:4px}
.feature .version{font-size:12px;color:var(--text-secondary);background:var(--bg);padding:2px 8px;border-radius:4px}
.feature .priority{font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px}
.feature .priority.p0{background:rgba(239,68,68,.2);color:var(--danger)}
.feature .priority.p1{background:rgba(245,158,11,.2);color:var(--warning)}
.feature .priority.p2{background:rgba(59,130,246,.2);color:var(--accent)}
.feature .priority.p3{background:rgba(139,92,246,.2);color:var(--purple)}
.feature .notes{grid-column:1/-1;font-size:12px;color:var(--text-secondary);padding-top:8px;border-top:1px solid var(--border);margin-top:4px}
.theme-toggle{position:fixed;top:20px;right:20px;background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px}
@media (max-width:768px){
  .feature{grid-template-columns:1fr;gap:8px}
  .feature .status{width:auto}
  .stats{justify-content:center}
}
@media print{
  body{background:#fff;color:#000}
  .feature,.stat,.category{break-inside:avoid}
  .theme-toggle,.filters{display:none}
}
</style>
</head>
<body>
<button class="theme-toggle" onclick="document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme')==='light'?'':'light')">切换主题</button>
<div class="container">
  <div class="header">
    <h1>🧹 Cleandup 功能清单 <span class="version-tag">$Version</span></h1>
    <div class="meta">生成时间: $timestamp | 共 $total 项功能</div>
  </div>
  
  <div class="stats">
    <div class="stat done"><div class="num">$done</div><div class="label">已完成</div></div>
    <div class="stat doing"><div class="num">$doing</div><div class="label">进行中</div></div>
    <div class="stat plan"><div class="num">$plan</div><div class="label">规划中</div></div>
  </div>
  
  <div class="filters">
    <button class="filter-btn active" data-filter="all">全部</button>
    <button class="filter-btn" data-filter="done">已完成</button>
    <button class="filter-btn" data-filter="doing">进行中</button>
    <button class="filter-btn" data-filter="plan">规划中</button>
  </div>
  
  <div id="categories">
"@

foreach ($cat in $categories) {
    $catName = $cat.Name
    $catFeatures = @($cat.Group)
    $catDone = @($catFeatures | Where-Object { $_.Status -eq "已完成" }).Count
    $catTotal = $catFeatures.Count
    
    $html += @"
    <div class="category" data-category="$catName">
      <div class="category-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="arrow">▼</span>
        <h2>$catName</h2>
        <span class="count">$catDone/$catTotal</span>
      </div>
      <div class="feature-list">
"@
    
    foreach ($f in $catFeatures) {
        $statusClass = switch ($f.Status) { "已完成" { "done" } "进行中" { "doing" } "规划中" { "plan" } }
        $statusText = switch ($f.Status) { "已完成" { "✅ 已完成" } "进行中" { "🚧 进行中" } "规划中" { "📋 规划中" } }
        $priorityClass = $f.Priority.ToLower()
        
        $html += @"
        <div class="feature" data-status="$($f.Status)">
          <span class="status $statusClass">$statusText</span>
          <div>
            <div class="name">$($f.Name)</div>
            <div class="desc">$($f.Description)</div>
          </div>
          <span class="version">$($f.Version)</span>
          <span class="priority $priorityClass">$($f.Priority)</span>
          $(if ($f.Notes) { "<div class='notes'>📝 $($f.Notes)</div>" })
        </div>
"@
    }
    
    $html += @"
      </div>
    </div>
"@
}

$html += @"
  </div>
</div>

<script>
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.filter;
    document.querySelectorAll('.feature').forEach(f => {
      if (filter === 'all' || f.dataset.status === filter) {
        f.style.display = '';
      } else {
        f.style.display = 'none';
      }
    });
  });
});
</script>
</body>
</html>
"@

$html | Out-File -FilePath $htmlPath -Encoding UTF8
Write-Host "HTML 已生成: $htmlPath" -ForegroundColor Green

# 输出摘要
Write-Host ""
Write-Host "=== 功能清单摘要 ===" -ForegroundColor Cyan
Write-Host "版本: $Version"
Write-Host "总功能: $total"
Write-Host "已完成: $done" -ForegroundColor Green
Write-Host "进行中: $doing" -ForegroundColor Yellow
Write-Host "规划中: $plan" -ForegroundColor Magenta
Write-Host ""
Write-Host "文件输出:"
Write-Host "  CSV:  $csvPath"
Write-Host "  HTML: $htmlPath"
