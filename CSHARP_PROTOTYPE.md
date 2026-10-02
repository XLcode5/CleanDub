# CleanDub C# WinForms 原型
# 需要 .NET 6+ SDK 或 Visual Studio

## 快速开始

### 安装 .NET SDK（如未安装）
```powershell
# 下载 .NET 8 SDK
Invoke-WebRequest -Uri "https://dot.net/v1/dotnet-install.ps1" -OutFile "dotnet-install.ps1"
.\dotnet-install.ps1 -Channel 8.0
```

### 创建项目
```powershell
dotnet new winforms -n CleanDub.Gui
cd CleanDub.Gui
```

### 运行
```powershell
dotnet run
```

### 打包为单文件 exe
```powershell
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

输出：`bin/Release/net8.0-windows/win-x64/publish/CleanDub.Gui.exe`

## 项目结构

```
CleanDub.Gui/
├── Program.cs              # 入口
├── MainForm.cs             # 主窗口
├── ScanEngine.cs           # 调用 PowerShell 扫描
├── Models.cs               # 数据模型
└── Resources/
    └── dedup_core.ps1      # 嵌入的 PowerShell 引擎
```

## 核心代码预览

### Program.cs
```csharp
namespace CleanDub.Gui;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
```

### MainForm.cs（主窗口）
```csharp
namespace CleanDub.Gui;

public partial class MainForm : Form
{
    private ScanEngine _engine = new();
    private List<DuplicateGroup> _groups = new();
    
    public MainForm()
    {
        InitializeComponent();
        InitializeCustom();
    }
    
    private void InitializeCustom()
    {
        // 深色主题
        BackColor = Color.FromArgb(15, 23, 42);
        ForeColor = Color.FromArgb(241, 245, 249);
        
        // 扫描按钮
        var btnScan = new Button
        {
            Text = "开始扫描",
            BackColor = Color.FromArgb(59, 130, 246),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Size = new Size(120, 40),
            Location = new Point(20, 20)
        };
        btnScan.Click += async (s, e) => await StartScan();
        Controls.Add(btnScan);
        
        // 进度条
        var progress = new ProgressBar
        {
            Location = new Point(20, 70),
            Size = new Size(600, 10),
            Style = ProgressBarStyle.Marquee
        };
        Controls.Add(progress);
        
        // 结果列表
        var listView = new ListView
        {
            Location = new Point(20, 100),
            Size = new Size(760, 400),
            View = View.Details,
            FullRowSelect = true,
            GridLines = true
        };
        listView.Columns.Add("目录", 300);
        listView.Columns.Add("文件数", 80);
        listView.Columns.Add("可释放", 100);
        Controls.Add(listView);
        
        // 状态栏
        var status = new Label
        {
            Text = "就绪",
            Location = new Point(20, 520),
            AutoSize = true
        };
        Controls.Add(status);
    }
    
    private async Task StartScan()
    {
        // 调用 PowerShell 引擎
        var results = await _engine.ScanAsync(@"C:\Users\Admin\Documents\WeChat Files");
        // 更新界面...
    }
}
```

## 界面预览（文字描述）

```
┌─────────────────────────────────────────┐
│  🧹 CleanDub          [深色] [设置] [?] │
├─────────────────────────────────────────┤
│                                         │
│  扫描目录: [C:\Users\...\WeChat Files] │
│            [浏览...]                    │
│                                         │
│  [✓] 递归子目录    保留: [最干净 ▼]    │
│  [✓] 检测硬链接    校验: [全量哈希 ▼]  │
│                                         │
│  [开始扫描]  [终止]                     │
│  ▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 50%  已用 12s     │
│                                         │
├─────────────────────────────────────────┤
│  重复组 │ 文件数 │ 可释放               │
│  ───────┼────────┼──────────           │
│  📁 2024-03│ 5     │ 128 MB  [选择]    │
│  📁 2024-02│ 3     │ 64 MB   [选择]    │
│  📁 2024-01│ 8     │ 256 MB  [选择]    │
│                                         │
├─────────────────────────────────────────┤
│  已勾选 5 个文件 · 预计释放 448 MB      │
│  [移入隔离区] [永久删除] [导出] [历史]  │
└─────────────────────────────────────────┘
```

## 与 HTML 版对比

| 特性 | HTML 版 | C# WinForms 版 |
|:---|:---|:---|
| 启动速度 | 慢（需启动服务+浏览器） | 快（直接运行） |
| 内存占用 | 高（浏览器+服务） | 低（单进程） |
| 界面响应 | 一般（Web 渲染） | 流畅（原生控件） |
| 系统集成 | 弱（无法托盘/开机启动） | 强（支持托盘/开机启动） |
| 离线运行 | ✅ | ✅ |
| 单文件分发 | ⚠️ 伪单文件 | ✅ 真单文件 |
| 安装包 | ❌ 需手动 | ✅ Inno Setup |

## 下一步

1. **安装 .NET 8 SDK**（如未安装）
2. **创建项目** `dotnet new winforms -n CleanDub.Gui`
3. **嵌入 PowerShell 引擎** 为资源
4. **实现扫描调用** 和结果展示
5. **打包单文件 exe**

**是否开始实际编码？需要先安装 .NET SDK。**