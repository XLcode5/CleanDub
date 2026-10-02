# CleanDub 架构重构方案

## 当前问题

| 问题 | 影响 |
|:---|:---|
| 启动器版需要外部文件 | 不是真正的单文件 |
| 单文件版释放到临时目录 | 启动慢，残留文件 |
| HTML 界面 | 无原生应用体验 |
| 无安装包 | 用户需要手动解压 |

## 推荐方案：C# WinForms 原生应用

### 架构
```
CleanDub.exe (C# WinForms)
├── 原生 GUI（无需浏览器）
├── 嵌入 PowerShell 引擎（调用系统 PowerShell）
├── 单文件（Costura.Fody 嵌入所有资源）
└── 可选：Inno Setup 安装包
```

### 优势
- 真正的单文件 exe（~5-10MB）
- 原生 Windows 界面，响应快
- 无需释放临时文件
- 支持系统托盘、开机启动
- 专业的安装包（可选）

### 实现步骤
1. 创建 C# WinForms 项目
2. 嵌入 PowerShell 脚本为资源
3. 调用 PowerShell 执行扫描
4. 解析结果并显示在原生界面
5. 打包为单文件 exe

## 备选方案：PowerShell 优化

如果坚持用 PowerShell：
1. 使用 **PS2EXE 的 `-noConfig`** 选项
2. 把资源嵌入为 Base64，但**预编译为 C# 程序集**
3. 使用 **PowerShell 7** 的 `pwsh -File` 模式

## 我的建议

**选 C# WinForms 方案**，理由：
- 用户体验最好
- 性能最优
- 最容易打包分发
- 可以真正利用 .NET 的异步和并行

**是否开始 C# WinForms 重构？**