# CleanDub macOS 风格重设计 操作记录（v0.4.1）

日期：2026-10-02
执行者：Codex
项目目录：D:\OpenClaw\clear app

## 一、任务接收

用户反馈：此前 DeepSeek 与 Hermes 已做过两轮优化，但对当前 .NET 编译出的界面不满意，要求借鉴 macOS 应用界面风格重新设计。用户进一步明确：只是借鉴而非完全照搬——最小化、最大化、关闭按钮按 Windows 习惯设计（右上角 ─ ▢ ✕、关闭悬停红色），但毛玻璃效果、椭圆弧角四角等苹果原生视觉元素需要保留，最终目标是更简洁、更美观。

## 二、代码改动清单

### 2.1 MacTheme.cs（主题与工具类，约 17 KB）

- 新增 FrostTint 颜色（浅色 75% 白磨砂 / 深色 80% 黑磨砂）。
- 新增 DwmHelper.EnableMica：DwmSetWindowAttribute(attr=38, DWMSBT_MAINWINDOW=2) 启用系统 Mica。
- 新增 Frosted 静态类：BlurredWallpaper() 读取注册表 TranscodedImageCache 壁纸路径，BuildBlurred() 以 1/14 降采样 + 1/4 放大模拟高斯模糊。
- 保留既有 MacTheme 浅/深双套配色、Gfx 抗锯齿辅助、MacIcons 矢量图标。

### 2.2 MacControls.cs（自绘控件库，约 25 KB）

- 删除 macOS 风格 TrafficLights（红黄绿三圆点，不符合 Windows 习惯）。
- 新增 CaptionButtons：右上角 Windows 风格 ─ ▢ ✕，关闭悬停 #E81123 红。
- 新增 FrostedPanel：壁纸模糊 + FrostTint 叠加 + 右缘 1px 发丝线的侧栏面板。
- 保留并打磨 MacButton / MacToggle / MacSegmented / MacTextBox / MacCard / MacProgressBar / MacNavItem / MacIconView / MacAlert。
- 修复 MacTextBox 构造函数崩溃。

### 2.3 MainForm.cs（主窗口，约 46 KB / 1216 行）

- 侧栏容器由普通 Panel 换成 FrostedPanel，实现毛玻璃导航栏。
- 标题栏接入 _caps（CaptionButtons），替换原 macOS 红黄绿按钮。
- WndProc 拦截 WM_NCLBUTTONDBLCLK 与 WM_GETMINMAXINFO：双击标题栏切换最大化，最大化时工作区不遮挡任务栏。
- 版本号提升至 v0.4.1。
- 新增扫描引擎 stdout 正则解析，结果列表实时填充重复组。
- “导出 CSV” 按钮接入 ExportCsv()。
- 深色主题移除强制禁用逻辑，接入 settings.json 持久化（DarkTheme 字段）。

### 2.4 CleanDub.Gui.csproj

- Version / AssemblyVersion / FileVersion 改为 0.4.1，并加注释覆盖环境变量里残留的 Version=V3.1.0.1。

### 2.5 结构调整

- 删除旧设计器文件 Form1.cs / Form1.Designer.cs。
- 新增 Models.cs（数据模型）与 ScanEngine.cs（扫描进程封装）。

## 三、Bug 修复记录

1. dedup.ps1 调用参数 -NoLinks 不存在，改为 -NoLinkCheck。
2. 扫描结果从不进入列表：补正则解析引擎输出并填充。
3. 导出 CSV 按钮无事件处理：接 ExportCsv()。
4. 深色主题被写死禁用：完整实现并持久化。
5. 修复编译期 4 处错误及 MacTextBox 构造崩溃。

## 四、构建与验证

- 环境：.NET 8 SDK（非标准路径 D:\OpenClaw\dotnet），每次构建前设置 PATH。
- 构建命令：dotnet build "D:\OpenClaw\clear app\CleanDub.Gui\CleanDub.Gui.csproj" -c Debug --nologo
- 注意：构建前必须先停止正在运行的 CleanDub 进程，否则 MSB3027 文件锁失败。
- 结果：0 警告、0 错误。
- 运行截图：PrintWindow（flags=2，无边框窗口只能用此方式；CopyFromScreen 截不到）。
- 浅色截图 light_v041_final.png（864x576）人工核验：右上角 ─ ▢ ✕ Windows 风格、侧栏壁纸模糊透出、圆角正常。
- 深色截图 dark_v041.png 同样核验通过。
- 最终截图已覆盖至 CleanDub.Gui\screenshot.png；settings.json 的 DarkTheme 已重置为 false（默认浅色）。

## 五、产出物清单

- 源代码：CleanDub.Gui 目录下 MacTheme.cs / MacControls.cs / MainForm.cs / Models.cs / ScanEngine.cs / Program.cs / CleanDub.Gui.csproj
- 最终截图：CleanDub.Gui\screenshot.png
- 总结报告：docs\macos-redesign-report.md
- 本操作记录：docs\operation-log.md
