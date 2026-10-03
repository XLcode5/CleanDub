# CleanDub C# WinForms — UI 重构设计报告

> **日期**: 2026-10-02 · **版本**: v0.3.0 · **作者**: XLcode5 · **代码量**: ~1,400 行 C#

---

## 设计理念

整体设计借鉴 **VS Code**、**Linear**、**GitHub Dark** 等现代化工具的视觉语言，追求**克制、清晰、高效**的桌面应用体验。

| 设计原则 | 体现 |
|:---|:---|
| 减少视觉噪音 | 无彩色装饰，单一蓝色强调色，灰阶背景层次 |
| 信息密度适中 | 卡片化分区，统计一行四栏，设置集中面板 |
| 即时反馈 | 自定义进度条、按钮三态 (normal/hover/pressed)、侧栏激活指示条 |
| 暗色优先 | 深色为默认，眼睛友好；浅色主题完整支持一键切换 |
| 语义化配色 | 12 个色变量覆盖全部 UI 状态，无硬编码色值散落 |

---

## 配色系统

两套完整主题，通过 `static class C` 集中管理。

### 深色主题（默认）

| 色变量 | 色值 | 用途 |
|:---|:---|:---|
| `Bg` | `#0D1117` | 窗口背景 |
| `Surface` | `#161B22` | 控件表面 |
| `Card` | `#1C2128` | 卡片背景 |
| `Border` | `#30363D` | 边框 |
| `Text` | `#E6EDF3` | 主文字 |
| `Text2` | `#8B949E` | 次文字 |
| `Accent` | `#58A6FF` | 强调色 |
| `Success` | `#3FB950` | 成功态 |
| `Warning` | `#D29922` | 警告态 |
| `Danger` | `#F85149` | 危险态 |

### 浅色主题

| 色变量 | 色值 | 用途 |
|:---|:---|:---|
| `Bg` | `#FFFFFF` | 窗口背景 |
| `Surface` | `#F6F8FA` | 控件表面 |
| `Border` | `#D0D7DE` | 边框 |
| `Text` | `#1F2328` | 主文字 |
| `Text2` | `#656D76` | 次文字 |

---

## 布局架构

```
┌──────────────┬─────────────────────────────────────────┐
│  220px 侧栏   │  🏷 重复文件清理                          │
│              │  内容级 SHA-256 判重 · 安全隔离区…        │
│  🔍 扫描      ├──────┬──────┬──────┬──────┬──────────────┤
│  ──────────  │ 重复组│ 待处理│ 可释放│ 耗时  │  ← 统计卡片 │
│  📋 历史      ├──────┴──────┴──────┴──────┴──────────────┤
│  📦 隔离区    │  扫描设置 / 进度条 / 结果列表 / 操作栏     │
│  ⚙ 设置      │                                             │
│              │                                             │
│  [🌙 主题]   │                                             │
└──────────────┴─────────────────────────────────────────┘
```

---

## 核心自定义控件

| 控件 | 特性 |
|:---|:---|
| **ModernButton** | GDI+ 自绘，圆角 8px，三态 (normal/hover/pressed)，支持填充/幽灵/危险三种样式 |
| **SidebarButton** | 左侧 3px 蓝色激活指示条，hover 半透明过渡，圆角 8px |
| **CustomProgressBar** | 自绘圆角进度条，蓝色填充 + 深色轨道 |
| **统计卡片** | Owner-draw Panel，10px 圆角 + 1px 边框，190×74px |
| **ListView** | Owner-draw，隔行变色，选中行蓝色高亮 |
| **GraphicsExtensions** | `FillRoundedRectangle` / `DrawRoundedRectangle` 通用方法 |

---

## 文件清单

| 文件 | 行数 | 状态 | 用途 |
|:---|:---|:---|:---|
| `MainForm.cs` | **950** | 🔥 重写 | 全新 UI：侧栏导航、统计卡片、5 个自定义控件、GDI+、双主题 |
| `Models.cs` | **179** | 新增 | 10 个类型：枚举 + 数据模型 |
| `ScanEngine.cs` | **269** | 新增 | PowerShell 引擎封装 |
| `Program.cs` | **14** | 更新 | 入口 + HighDpiMode |
| `CleanDub.Gui.csproj` | **22** | 更新 | 清理 Form1 引用 |
| `Form1.cs` | — | 删除 | 旧占位文件 |
| `Form1.Designer.cs` | — | 删除 | 旧设计器文件 |

---

## 旧版 vs 新版

| 维度 | 旧版 (393行) | 新版 (950行) |
|:---|:---|:---|
| 布局方式 | TableLayoutPanel 嵌套 | 手动定位 + Dock |
| 配色 | 硬编码散落各处 | 集中 12 色变量 + 双主题 |
| 主题切换 | 简单递归，覆盖不全 | ApplyTheme() + 控件级 SetColors() |
| 按钮 | 原生直角 Button | GDI+ 自绘圆角三态 |
| 统计区 | ❌ 无 | 四张圆角卡片 |
| 侧栏 | ❌ 无 | 220px 导航侧栏 |
| 进度条 | Marquee | 自绘圆角 |
| ListView | 原生 | Owner-draw 隔行变色 |
| 数据模型 | ❌ 匿名类型 | 10 个结构化类型 |
| 引擎封装 | 内嵌 Process.Start | 独立 ScanEngine + IProgress<T> |
| 高 DPI | ❌ | PerMonitorV2 |

---

## 待后续完善

| 功能 | 现状 | 建议 |
|:---|:---|:---|
| 结果列表填充 | 骨架就绪 | dedup_core.ps1 增加 `-Json` 参数输出结构化 JSON |
| 隔离区操作 | 按钮已就绪 | 调用 `dedup.ps1 -Action Quarantine -Yes` |
| 永久删除 | 二次确认已实现 | 调用 `dedup.ps1 -Action Permanent -Yes` |
| CSV 导出 | SaveFileDialog 已就绪 | 调用 ScanEngine.ExportCsvAsync() |
| 历史/隔离区/设置视图 | 侧栏导航已支持 | SwitchNav() 中切换主面板 |
| 自动更新 | version.json 已配置 | 调用 GitHub Releases API |

---

## 编译运行

```powershell
# 开发构建
cd "D:\OpenClaw\clear app\CleanDub.Gui"
dotnet build -c Release

# 单文件发布（自包含）
dotnet publish -c Release -r win-x64 --self-contained true     /p:PublishSingleFile=true     /p:IncludeNativeLibrariesForSelfExtract=true
```

输出 exe：`bin\Release\net6.0-windows\win-x64\publish\CleanDub.exe`

---

> CleanDub — 内容级重复文件清理工具 · [github.com/XLcode5/CleanDub](https://github.com/XLcode5/CleanDub) · MIT License
