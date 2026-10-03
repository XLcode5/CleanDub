# CleanDub macOS 风格 UI 重设计总结报告（v0.4.1）

日期：2026-10-02
版本：CleanDub.Gui v0.4.1
作者：Codex

## 一、设计目标

在 DeepSeek 与 Hermes 前两轮优化的基础上，对 CleanDub 的 WinForms 界面进行第三次重设计。本次核心原则：

- 借鉴 macOS 的质感，但不照搬 macOS 的交互习惯。
- 窗口控制按钮（最小化、最大化、关闭）遵循 Windows 用户习惯：位于标题栏右侧，glyphs 为 ─ ▢ ✕，关闭按钮悬停时变为 Windows 标准红 #E81123。
- 借鉴苹果原生应用的视觉元素：毛玻璃侧栏、大圆角卡片与窗口四角、SF 风格的分段控件与开关、细腻的 1px 发丝分割线、克制的强调色。
- 最终目的：界面更简洁、更美观，信息层级更清晰。

## 二、视觉体系

### 2.1 窗口与标题栏

- 无边框窗口（FormBorderStyle.None），四角椭圆弧角（DWM 圆角 + 自绘抗锯齿裁剪）。
- 标题栏右侧为 Windows 风格三按钮：最小化 ─、最大化 ▢、关闭 ✕；关闭按钮悬停红色 #E81123，其余悬停为半透明灰。
- 双击标题栏切换最大化/还原；拦截 WM_NCLBUTTONDBLCLK 与 WM_GETMINMAXINFO，保证最大化时不遮挡任务栏。

### 2.2 毛玻璃侧栏（核心苹果元素）

- 侧栏使用 FrostedPanel，实时读取当前桌面壁纸（注册表 TranscodedImageCache），降采样至 1/14 后放大 1/4 模拟高斯模糊，再叠加 FrostTint 半透明 tint，形成类似 macOS 访达侧栏的磨砂通透感。
- 同时调用 DWM API（DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_MAINWINDOW）为整个窗口启用 Mica backdrop，双管齐下。
- 侧栏右缘绘制 1px 发丝分割线（Hairline），深色模式下为 12% 白色、浅色为 15% 黑色。

### 2.3 配色（MacTheme，浅/深双套）

| 语义 | 浅色 | 深色 |
|---|---|---|
| WindowBg 窗口底 | 245,245,247 | 30,30,32 |
| SidebarBg 侧栏底 | 232,232,237 | 38,38,41 |
| CardFace 卡片面 | 白色 | 44,44,47 |
| Ink 主文字 | 29,29,31 | 245,245,247 |
| Ink2 次文字 | 110,110,115 | 152,152,157 |
| Accent 强调蓝 | 0,122,255 | 10,132,255 |
| Danger 危险红 | 255,59,48 | 255,69,58 |
| Success 成功绿 | 40,180,80 | 48,209,88 |
| FrostTint 磨砂层 | 75% 244,244,248 | 80% 26,26,28 |

所有颜色走 MacTheme.IsDark 统一切换，主题选择持久化到 settings.json 的 DarkTheme 字段。

## 三、自绘控件清单（MacControls.cs，共 11 个）

| 控件 | 说明 |
|---|---|
| CaptionButtons | Windows 习惯的最小化/最大化/关闭按钮组 |
| FrostedPanel | 壁纸模糊毛玻璃面板，用于侧栏 |
| MacButton | 圆角按钮（填充/描边/文字三种样式） |
| MacToggle | iOS 风格滑动开关 |
| MacSegmented | SF 风格分段选择器（扫描模式切换） |
| MacTextBox | 圆角输入框，带焦点光环 FocusRing |
| MacCard | 圆角卡片容器，8px 弧角 |
| MacProgressBar | 细条圆角进度条 |
| MacNavItem | 侧栏导航项，选中为圆角 pill 高亮 |
| MacIconView | 矢量图标绘制（放大镜、文件夹、齿轮等） |
| MacAlert | 圆角模态提示框 |

图标全部由 MacIcons 静态类用 GDI+ 路径矢量绘制，不依赖外部图片资源。

## 四、本次顺带修复的功能 Bug

1. dedup.ps1 参数名错误：-NoLinks 改为 -NoLinkCheck，扫描不再因参数不存在而失败。
2. 结果列表从不填充：新增对引擎 stdout 的正则解析，重复组实时显示在结果列表。
3. “导出 CSV” 按钮未接事件：已接 ExportCsv()，可正常导出结果。
4. 深色主题此前被强制禁用：现已完整实现并持久化。
5. MacTextBox 构造函数崩溃及 4 处编译错误全部修复。

## 五、验证结论

- dotnet build 编译通过：0 警告、0 错误。
- PrintWindow 截图验证（浅色 864x576、深色各一张）：
  - 右上角为 Windows 风格 ─ ▢ ✕ 按钮，关闭悬停变红；
  - 侧栏可见壁纸模糊透出的磨砂效果；
  - 窗口四角与卡片圆角抗锯齿正常；
  - 深色模式整体配色对比度正常，无明显刺眼色块。
- 最终效果图：CleanDub.Gui\screenshot.png。

## 六、后续建议

- 高 DPI（150%+）下 FrostedPanel 模糊半径可再调优。
- 可考虑给侧栏导航加快捷键提示 tooltip。
- 若未来迁移 WinUI 3，可直接获得系统级 Mica，无需自绘壁纸模糊。
