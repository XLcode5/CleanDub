# CleanDub C# WinForms — 开发交接文档

> 日期: 2026-10-02 | 版本: v0.3.0 | 目标框架: .NET 8.0 | 编译: 通过 (0 error)

---

## 1. 项目概述

CleanDub 是 Windows 重复文件清理工具。核心引擎为 PowerShell (dedup_core.ps1, 三级流水线: 大小分组 -> 32KB prehash -> 全量 SHA-256), C# WinForms 为其原生桌面 GUI。

### 代码量

| 文件 | 行数 | 职责 |
|:---|:---|:---|
| MainForm.cs | ~455 | 窗口布局、侧栏导航、主题、扫描流程 |
| Models.cs | 179 | 10 个数据模型 (枚举 + POCO) |
| ScanEngine.cs | 269 | PowerShell 引擎封装 (异步扫描、stdout 解析、取消) |
| Program.cs | 14 | 入口 + HighDpiMode |
| CleanDub.Gui.csproj | 22 | 项目配置 |
| 合计 | ~940 | |

---

## 2. 设计决策

### 2.1 为什么选原生控件而非自绘

第一版用 GDI+ 自绘了 ModernButton / SidebarButton / CustomProgressBar (~600 行), 效果不稳定: 文字折行、跨 DPI 模糊、暗色主题配色难调。第二版回归 WinForms 原生控件 (FlatStyle.Flat + FlatAppearance), 仅保留统计卡片和设置面板的圆角边框自绘 (~20 行 DrawRoundedRectangle)。

| 自绘版 | 原生版 |
|:---|:---|
| 按钮文字折行 | 原生 Button 永不折行 |
| 跨 DPI 模糊 | 系统级 DPI 缩放 |
| 颜色需要手动调两套 | FlatAppearance 自动跟随系统 |
| 代码复杂难维护 | 简洁, 标准 WinForms |

### 2.2 默认浅色主题

工具类应用用浅色更专业。配色参考 GitHub / Windows 11 白底风格:

| 色变量 | 色值 | 用途 |
|:---|:---|:---|
| Bg | #FAFBFC | 页面背景 |
| Surface | #FFFFFF | 卡片/文本框 |
| Border | #E1E4E8 | 边框 |
| Text | #24292E | 主文字 |
| Text2 | #6A737D | 次文字 |
| Accent | #0969DA | 强调色 |
| SidebarBg | #F6F8FA | 侧栏背景 |
| Danger | #CF222E | 危险操作 |

### 2.3 布局架构

```
+----------+-------------------------------------------+
| 200px    |  重复文件清理                   22px Bold |
| 侧栏     |  内容级 SHA-256 判重 . 安全隔离区          |
|          +------+------+------+------+---------------+
| CleanDub |重复组|待处理|可释放| 耗时 | <- 统计卡片     |
| v0.3.0   +------+------+------+------+---------------+
|          |  +- 扫描设置 ---------------------------------+
| 扫描     |  | 扫描目录 [___________] [浏览...]          |
| 历史     |  | 保留策略 [v________] 校验 [v_____]        |
| 隔离区   |  | 递归 硬链接          [扫描] [终止]        |
| 设置     |  +-------------------------------------------+
|          |  |||||||||||||/////  正在扫描...               |
| -------- |  +- 结果列表 ---------------------------------+
| 浅色     |  | 目录 | 文件数 | 可释放 | 保留文件         |
+----------+-------------------------------------------+
```

---

## 3. 编译 & 运行

### 前置条件

本机 .NET SDK 位于非标准路径:

```powershell
# .NET 8 SDK: D:\OpenClaw\dotnet\
# .NET 6 SDK: D:\OpenClaw\dotnet6\  (备用, 当前项目用 .NET 8)
```

WARNING: 环境变量 Version=V3.1.0.1 会被 MSBuild 当作 $(Version) 全局属性, 已在 csproj 中显式覆盖为 <Version>0.3.0</Version>。

### 开发构建

```powershell
$env:PATH = "D:\OpenClaw\dotnet;" + $env:PATH
cd "D:\OpenClaw\clear app\CleanDub.Gui"
dotnet build -c Debug
```

### 单文件发布

```powershell
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

输出: bin\Release\net8.0-windows\win-x64\publish\CleanDub.exe

### 当前构建产物

- exe: CleanDub.Gui\bin\Debug\net8.0-windows\CleanDub.exe
- dll: CleanDub.Gui\bin\Debug\net8.0-windows\CleanDub.dll

---

## 4. 数据模型 (Models.cs)

| 类型 | 说明 |
|:---|:---|
| ScanPhase 枚举 | Idle/Indexing/SizeGrouping/PreHashing/FullHashing/Completed/Canceled/Error |
| RetentionStrategy 枚举 | Cleanest/Newest/Original/Highest |
| VerifyLevel 枚举 | Full/Head/Name/Size |
| ScanProgress | 进度快照, 含 PhaseLabel 中文翻译、ProgressPercent |
| DuplicateGroup | 重复组 (目录、文件数、可释放字节、KeeperPath、Victims 列表) |
| DuplicateFile | 单个重复文件 (路径、大小、哈希、是否为 Keeper、勾选状态) |
| ScanResult | 完整扫描结果 (含格式化属性 RealLabel/ElapsedLabel) |
| OpLogEntry | 操作日志条目 |
| AppSettings | 应用设置 |

---

## 5. 已完成 vs 待完成

### DONE 已完成

- 完整 UI 布局 (侧栏 + 统计卡片 + 设置面板 + 结果列表 + 操作栏)
- 四按钮侧栏导航 (扫描/历史/隔离区/设置) + 蓝色激活指示条
- 浅色主题 + 配色系统
- PowerShell 引擎异步调用封装 (ScanEngine)
- 扫描按钮交互逻辑 (禁用态、终止按钮、进度条)
- 窗口最小尺寸 880x560 + 响应式文本框
- HighDPI 支持 (PerMonitorV2)
- 数据模型完整定义

### TODO 待完成

| 功能 | 优先级 | 说明 |
|:---|:---|:---|
| 结果列表填充真实数据 | P0 | 需让 dedup_core.ps1 输出 JSON, ScanEngine 解析后填充 ListView |
| 隔离区操作 | P0 | 按钮已就绪, 需调用 dedup.ps1 -Action Quarantine -Yes |
| 永久删除 | P0 | 二次确认已实现, 需调用 dedup.ps1 -Action Permanent -Yes |
| CSV 导出 | P1 | SaveFileDialog 待集成, ScanEngine.ExportCsvAsync() 已实现 |
| 历史/隔离区/设置视图 | P1 | 侧栏导航已支持, 需在 SwitchNav() 中切换主面板内容 |
| 文件预览 | P2 | 缩略图、文本前 N 行 |
| 深色主题 | P2 | 配色变量已预留, ToggleTheme() 骨架就绪 |
| 自动更新检查 | P2 | version.json 指向 GitHub Releases API |
| 安装包 | P3 | Inno Setup 脚本在 release/setup.iss |

---

## 6. 关键文件索引

| 路径 | 说明 |
|:---|:---|
| CleanDub.Gui/MainForm.cs | 主窗口 (~455行) |
| CleanDub.Gui/Models.cs | 数据模型 |
| CleanDub.Gui/ScanEngine.cs | PowerShell 引擎封装 |
| CleanDub.Gui/Program.cs | 入口 |
| CleanDub.Gui/CleanDub.Gui.csproj | 项目配置 (含 Version=0.3.0 修复) |
| dedup_core.ps1 | PowerShell 引擎 (783行) |
| dedup_server.ps1 | Web 服务版 |
| dedup_ui.html | Web UI 版 |
| docs/design-report.html | 首版设计报告 |
| docs/design-report.md | 首版设计报告 (Markdown) |
| CleanDub.Gui/ui-preview.html | HTML 交互预览 |

---

## 7. 已知问题 & 踩坑记录

### 7.1 NuGet 还原失败: 环境变量 Version=V3.1.0.1

系统环境变量 Version=V3.1.0.1 被 MSBuild 自动继承为 $(Version) 全局属性, 导致 NuGet 版本解析失败。
修复: 在 csproj 中显式添加 <Version>0.3.0</Version>。

### 7.2 属性名遮蔽 Control.Text

MainForm 的属性 public Color Text 遮蔽了 Control.Text (string), 导致编译错误。
修复: 重命名为 ForeText, 但在最终版中完全移除了主题属性类, 改用原生控件。

### 7.3 SmoothingMode.AntiAliasing 拼写错误

正确拼写是 SmoothingMode.AntiAlias (无 -ing)。

### 7.4 元组元素访问语法错误

navItems[i.Item1] -> 应为 navItems[i].Item1。

---

## 8. 会话总结

| 阶段 | 产出 |
|:---|:---|
| 1. 项目预览 | 扫描 20+ 文件, 识别出 PowerShell 引擎 + Web UI + C# 原型的多形态架构 |
| 2. C# 原型完善 | 新建 Models.cs (179行) + ScanEngine.cs (269行), 重写 MainForm.cs |
| 3. 设计报告 | 生成 HTML/Markdown 设计报告到 docs/ 目录 |
| 4. 编译调试 | 排查 NuGet 环境变量污染、C# 编译错误、.NET SDK 路径 |
| 5. UI 迭代 | 三轮: 自绘版 -> 多行布局 -> 原生控件浅色版 (最终) |
| 6. 交接文档 | 本文档 |

