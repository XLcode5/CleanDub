# CleanDub UI 重构设计规范

> 基于 ui-ux-pro-max 设计数据 + 仓库管家源码诊断
> 生成时间: 2026-10-03
> 分支: refactor/ui-simplify

---

## 1. 设计哲学

**Minimalism & Swiss Style** — 干净、简单、宽敞、功能性、留白、高对比、几何、无衬线、网格、只保留必要元素。

> "Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential. Best for: dashboards, SaaS platforms, professional tools. gap: 2rem, no box-shadow unless necessary."
> — ui-ux-pro-max styles.csv #minimalism-and-swiss-style

---

## 2. 配色方案 (Knowledge Base)

来源: ui-ux-pro-max colors.csv #1

### 浅色模式

| 角色 | 色值 | 用途 |
|:---|:---|:---|
| Primary | `#475569` | 主按钮、标题 |
| On Primary | `#FFFFFF` | 主按钮文字 |
| Secondary | `#64748B` | 次要按钮 |
| Accent | `#2563EB` | 链接、聚焦、强调 |
| Background | `#F8FAFC` | 窗口背景 |
| Foreground | `#1E293B` | 主文字 |
| Card | `#FFFFFF` | 卡片背景 |
| Muted | `#EAEFF3` | 禁用/悬停背景 |
| Muted Foreground | `#475569` | 次级文字 |
| Border | `#E2E8F0` | 边框、分割线 |
| Destructive | `#DC2626` | 删除、危险操作 |
| Success | `#16A34A` | 成功、保留标记 |
| Warning | `#D97706` | 警告 |

### 暗色模式 (GitHub Dark)

| 角色 | 色值 |
|:---|:---|
| Background | `#0D1117` |
| Card/Surface | `#161B22` |
| Border | `#30363D` |
| Text | `#E6EDF3` |
| Text Secondary | `#8B949E` |
| Accent | `#58A6FF` |
| Danger | `#F85149` |

---

## 3. 字体配对 (Medical Clean)

来源: ui-ux-pro-max typography.csv #1

| 层级 | 字体 | 字重 | 用途 |
|:---|:---|:---|:---|
| Heading | Figtree | 600-700 | 页面标题、卡片标题、统计数字 |
| Body | Noto Sans | 400-500 | 正文、标签、按钮文字 |
| Data | Figtree | 500 | 文件大小、数字显示 |

Windows 回退: Segoe UI → Microsoft YaHei

---

## 4. 信息架构

### 改造前 (4 页导航)

```
┌─────────┬──────────────────────────┐
│ 扫描     │ [统计卡片×4]              │
│ 历史     │ [设置卡片 6 控件]         │
│ 隔离区   │ [进度]                    │
│ 设置     │ [结果列表]                │
│         │ [操作按钮×3]              │
└─────────┴──────────────────────────┘
```

### 改造后 (单页 + 底部 Tab)

```
┌─────────────────────────────────────────┐
│  CleanDub                    [_][□][×]  │
├─────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌──────┐ ┌────┐ │
│  │ 重复组  │ │ 待处理  │ │可释放 │ │耗时│ │
│  └────────┘ └────────┘ └──────┘ └────┘ │
│  ┌─────────────────────────────────────┐│
│  │ 📁 扫描目录  [________________] 🔍  ││
│  │ ⚙ 保留策略 [名字最干净 ▾] 校验 [全量 ▾]││
│  │ ☐ 递归子目录  ☐ 检测硬链接  [开始扫描]││
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │ ▸ C:\Docs\项目方案  (3文件, 可释放12M)││
│  │   ☑ 方案_v2.docx  12.8 MB           ││
│  │   ☑ 方案_v3.docx  12.8 MB           ││
│  │   ✓ 方案_final.docx (保留)          ││
│  │ ▸ C:\Video\素材    (2文件, 609M)    ││
│  └─────────────────────────────────────┘│
│  已选 4 个文件 · 可释放 635 MB          │
│        [移入隔离区] [导出CSV] [永久删除] │
├─────────────────────────────────────────┤
│  🕐 历史  │  📦 隔离区  │  ⚙ 设置       │
└─────────────────────────────────────────┘
```

---

## 5. 控件简化清单

| 原控件 | 替换为 | 理由 |
|:---|:---|:---|
| MacSegmented | ComboBox (DropDownList) | 4-5 选项用下拉足够 |
| MacToggle | CheckBox (FlatStyle.Flat) | 原生支持 |
| MacTextBox | TextBox (BorderStyle.FixedSingle) | 原生 |
| MacProgressBar | ProgressBar | 原生 |
| MacCard | Panel + 1px Border | 不需要自绘圆角 |
| MacIconView | 文本符号 (▶ ⏹ 📁 ⚙) | 不需要图标引擎 |
| Toast | MessageBox / StatusStrip | 简单提示 |
| MacAlert | MessageBox.Show | 原生对话框 |
| FrostedPanel | Panel (纯色背景) | 不需要毛玻璃 |
| CaptionButtons | 原生标题栏 | WinForms 自带 |

---

## 6. 代码指标

| 指标 | 基线 | 目标 | 削减 |
|:---|:---|:---|:---|
| MainForm.cs | 1826 行 | ~600 行 | -67% |
| MacControls.cs | 731 行 | ~100 行 | -86% |
| 自定义控件类 | 16 个 | 5 个 | -69% |
| 总代码行数 | 4537 行 | ~2500 行 | -45% |
| 导航页数 | 4 页 | 单页+3 Tab | 深度 -1 |
| 设置输入位 | 12 个 | 5 个 | -58% |

---

## 7. 实施阶段

| 阶段 | 内容 | 状态 |
|:---|:---|:---|
| Phase 1 | 删除设置页双向同步，设置内联到扫描页 | 🔄 执行中 |
| Phase 2 | 移除毛玻璃/自绘窗口按钮，原生标题栏 | 🔄 执行中 |
| Phase 3 | 简化自定义控件为原生控件 | 🔄 执行中 |
| Phase 4 | 配色切换到 Knowledge Base 方案 | ⏳ 待执行 |
| Phase 5 | 合并 4 页导航为单页+底部 Tab | ⏳ 待执行 |
| Phase 6 | 删除 CleanDub.Native (WebView2 版本) | ⏳ 待执行 |

---

## 8. 参考来源

- ui-ux-pro-max products.csv: Developer Tool / Productivity Tool
- ui-ux-pro-max styles.csv: Minimalism & Swiss Style, Dark Mode (OLED), Bento Box Grid
- ui-ux-pro-max colors.csv: Knowledge Base/Documentation
- ui-ux-pro-max typography.csv: Medical Clean (Figtree + Noto Sans)
- ui-ux-pro-max ux-guidelines.csv: Progressive Disclosure
