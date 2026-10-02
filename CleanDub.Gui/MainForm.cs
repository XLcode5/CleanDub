using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CleanDub.Gui;

public partial class MainForm : Form
{
    private TextBox txtPath = null!;
    private Button btnBrowse = null!;
    private Button btnScan = null!;
    private Button btnStop = null!;
    private ComboBox cmbStrategy = null!;
    private ComboBox cmbVerify = null!;
    private CheckBox chkRecurse = null!;
    private CheckBox chkLinks = null!;
    private ProgressBar progressBar = null!;
    private Label lblStatus = null!;
    private ListView listResults = null!;
    private Label lblSummary = null!;
    private Button btnQuarantine = null!;
    private Button btnDelete = null!;
    private Button btnExport = null!;
    private Button btnHistory = null!;
    private Button btnTheme = null!;
    private bool isDarkTheme = true;
    private CancellationTokenSource? _cts;

    public MainForm()
    {
        InitializeCustom();
        ApplyTheme();
    }

    private void InitializeCustom()
    {
        // 窗体设置
        Text = "CleanDub - 重复文件清理";
        Size = new Size(900, 700);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(800, 600);

        // 主布局
        var mainPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(20),
            RowCount = 5,
            ColumnCount = 1
        };
        mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 标题
        mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 设置
        mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 进度
        mainPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); // 结果
        mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 底部按钮

        // 标题栏
        var titlePanel = new Panel { Dock = DockStyle.Top, Height = 50 };
        var lblTitle = new Label
        {
            Text = "🧹 CleanDub",
            Font = new Font("Segoe UI", 18, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(0, 10)
        };
        btnTheme = new Button
        {
            Text = "🌙 深色",
            Size = new Size(80, 30),
            Location = new Point(titlePanel.Width - 90, 10),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
            FlatStyle = FlatStyle.Flat
        };
        btnTheme.Click += (s, e) => { isDarkTheme = !isDarkTheme; ApplyTheme(); };
        titlePanel.Controls.Add(lblTitle);
        titlePanel.Controls.Add(btnTheme);
        mainPanel.Controls.Add(titlePanel, 0, 0);

        // 设置面板
        var settingsPanel = new GroupBox
        {
            Text = "扫描设置",
            Dock = DockStyle.Top,
            Height = 120,
            Padding = new Padding(10)
        };

        var settingsGrid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 3
        };
        settingsGrid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        settingsGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        settingsGrid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        settingsGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));

        // 扫描目录
        settingsGrid.Controls.Add(new Label { Text = "扫描目录:", AutoSize = true }, 0, 0);
        var pathPanel = new Panel { Dock = DockStyle.Fill };
        txtPath = new TextBox
        {
            Dock = DockStyle.Fill,
            Text = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) + "\\WeChat Files"
        };
        btnBrowse = new Button
        {
            Text = "浏览...",
            Dock = DockStyle.Right,
            Width = 70
        };
        btnBrowse.Click += BtnBrowse_Click;
        pathPanel.Controls.Add(txtPath);
        pathPanel.Controls.Add(btnBrowse);
        settingsGrid.Controls.Add(pathPanel, 1, 0);

        // 保留策略
        settingsGrid.Controls.Add(new Label { Text = "保留策略:", AutoSize = true }, 2, 0);
        cmbStrategy = new ComboBox
        {
            Dock = DockStyle.Fill,
            DropDownStyle = ComboBoxStyle.DropDownList
        };
        cmbStrategy.Items.AddRange(new object[] { "名字最干净", "修改时间最新", "无后缀原件", "(N) 数字最大" });
        cmbStrategy.SelectedIndex = 0;
        settingsGrid.Controls.Add(cmbStrategy, 3, 0);

        // 扫描方式
        settingsGrid.Controls.Add(new Label { Text = "扫描方式:", AutoSize = true }, 0, 1);
        cmbVerify = new ComboBox
        {
            Dock = DockStyle.Fill,
            DropDownStyle = ComboBoxStyle.DropDownList
        };
        cmbVerify.Items.AddRange(new object[] { "全量哈希（准确）", "只比头部（最快）", "只比文件名", "只比文件大小" });
        cmbVerify.SelectedIndex = 0;
        settingsGrid.Controls.Add(cmbVerify, 1, 1);

        // 选项
        var optionsPanel = new FlowLayoutPanel { Dock = DockStyle.Fill };
        chkRecurse = new CheckBox { Text = "递归子目录", Checked = true, AutoSize = true };
        chkLinks = new CheckBox { Text = "检测硬链接", Checked = true, AutoSize = true };
        optionsPanel.Controls.Add(chkRecurse);
        optionsPanel.Controls.Add(chkLinks);
        settingsGrid.Controls.Add(optionsPanel, 3, 1);

        // 按钮
        var btnPanel = new FlowLayoutPanel { Dock = DockStyle.Fill };
        btnScan = new Button
        {
            Text = "开始扫描",
            Size = new Size(100, 35),
            BackColor = Color.FromArgb(59, 130, 246),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 10, FontStyle.Bold)
        };
        btnScan.Click += async (s, e) => await StartScanAsync();
        btnStop = new Button
        {
            Text = "终止",
            Size = new Size(60, 35),
            Enabled = false,
            FlatStyle = FlatStyle.Flat
        };
        btnStop.Click += (s, e) => _cts?.Cancel();
        btnPanel.Controls.Add(btnScan);
        btnPanel.Controls.Add(btnStop);
        settingsGrid.Controls.Add(btnPanel, 0, 2);

        settingsPanel.Controls.Add(settingsGrid);
        mainPanel.Controls.Add(settingsPanel, 0, 1);

        // 进度面板
        var progressPanel = new Panel { Dock = DockStyle.Top, Height = 60 };
        progressBar = new ProgressBar
        {
            Dock = DockStyle.Top,
            Height = 8,
            Style = ProgressBarStyle.Marquee,
            Visible = false
        };
        lblStatus = new Label
        {
            Text = "就绪",
            Dock = DockStyle.Bottom,
            Height = 30,
            TextAlign = ContentAlignment.MiddleLeft
        };
        progressPanel.Controls.Add(progressBar);
        progressPanel.Controls.Add(lblStatus);
        mainPanel.Controls.Add(progressPanel, 0, 2);

        // 结果列表
        listResults = new ListView
        {
            Dock = DockStyle.Fill,
            View = View.Details,
            FullRowSelect = true,
            GridLines = true,
            CheckBoxes = true
        };
        listResults.Columns.Add("目录", 250);
        listResults.Columns.Add("文件数", 80);
        listResults.Columns.Add("可释放", 100);
        listResults.Columns.Add("状态", 80);
        mainPanel.Controls.Add(listResults, 0, 3);

        // 底部按钮
        var bottomPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 50,
            FlowDirection = FlowDirection.LeftToRight,
            Padding = new Padding(0, 10, 0, 0)
        };

        lblSummary = new Label
        {
            Text = "尚未扫描",
            AutoSize = true,
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(0, 10, 20, 0)
        };
        bottomPanel.Controls.Add(lblSummary);

        btnQuarantine = new Button { Text = "移入隔离区", Size = new Size(100, 35), Enabled = false };
        btnDelete = new Button { Text = "永久删除", Size = new Size(100, 35), Enabled = false, ForeColor = Color.Red };
        btnExport = new Button { Text = "导出 CSV", Size = new Size(80, 35), Enabled = false };
        btnHistory = new Button { Text = "历史记录", Size = new Size(80, 35) };

        bottomPanel.Controls.Add(btnQuarantine);
        bottomPanel.Controls.Add(btnDelete);
        bottomPanel.Controls.Add(btnExport);
        bottomPanel.Controls.Add(btnHistory);

        mainPanel.Controls.Add(bottomPanel, 0, 4);
        Controls.Add(mainPanel);
    }

    private void ApplyTheme()
    {
        if (isDarkTheme)
        {
            BackColor = Color.FromArgb(15, 23, 42);
            ForeColor = Color.FromArgb(241, 245, 249);
            btnTheme.Text = "☀️ 浅色";
        }
        else
        {
            BackColor = Color.FromArgb(241, 245, 249);
            ForeColor = Color.FromArgb(30, 41, 59);
            btnTheme.Text = "🌙 深色";
        }

        foreach (Control ctrl in Controls)
        {
            ApplyThemeToControl(ctrl);
        }
    }

    private void ApplyThemeToControl(Control ctrl)
    {
        if (ctrl is Button btn)
        {
            btn.BackColor = isDarkTheme ? Color.FromArgb(30, 41, 59) : Color.White;
            btn.ForeColor = isDarkTheme ? Color.FromArgb(241, 245, 249) : Color.FromArgb(30, 41, 59);
            btn.FlatAppearance.BorderColor = isDarkTheme ? Color.FromArgb(51, 65, 85) : Color.FromArgb(203, 213, 225);
        }
        else if (ctrl is TextBox txt)
        {
            txt.BackColor = isDarkTheme ? Color.FromArgb(30, 41, 59) : Color.White;
            txt.ForeColor = isDarkTheme ? Color.FromArgb(241, 245, 249) : Color.FromArgb(30, 41, 59);
            txt.BorderStyle = BorderStyle.FixedSingle;
        }
        else if (ctrl is ComboBox cmb)
        {
            cmb.BackColor = isDarkTheme ? Color.FromArgb(30, 41, 59) : Color.White;
            cmb.ForeColor = isDarkTheme ? Color.FromArgb(241, 245, 249) : Color.FromArgb(30, 41, 59);
        }
        else if (ctrl is ListView lv)
        {
            lv.BackColor = isDarkTheme ? Color.FromArgb(30, 41, 59) : Color.White;
            lv.ForeColor = isDarkTheme ? Color.FromArgb(241, 245, 249) : Color.FromArgb(30, 41, 59);
        }
        else if (ctrl is GroupBox gb)
        {
            gb.ForeColor = isDarkTheme ? Color.FromArgb(148, 163, 184) : Color.FromArgb(100, 116, 139);
        }

        foreach (Control child in ctrl.Controls)
        {
            ApplyThemeToControl(child);
        }
    }

    private void BtnBrowse_Click(object? sender, EventArgs e)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择扫描目录",
            SelectedPath = txtPath.Text
        };
        if (dialog.ShowDialog() == DialogResult.OK)
        {
            txtPath.Text = dialog.SelectedPath;
        }
    }

    private async Task StartScanAsync()
    {
        if (string.IsNullOrWhiteSpace(txtPath.Text) || !Directory.Exists(txtPath.Text))
        {
            MessageBox.Show("请选择有效的扫描目录", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        btnScan.Enabled = false;
        btnStop.Enabled = true;
        progressBar.Visible = true;
        progressBar.Style = ProgressBarStyle.Marquee;
        lblStatus.Text = "正在扫描...";
        listResults.Items.Clear();

        _cts = new CancellationTokenSource();

        try
        {
            // 调用 PowerShell 引擎
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dedup.ps1")}\" -Path \"{txtPath.Text}\" -DryRun",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var process = System.Diagnostics.Process.Start(psi);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await Task.Run(() => process.WaitForExit());

                // 解析结果（简化版）
                ParseScanResults(output);
            }
        }
        catch (OperationCanceledException)
        {
            lblStatus.Text = "已终止";
        }
        catch (Exception ex)
        {
            lblStatus.Text = $"错误: {ex.Message}";
        }
        finally
        {
            btnScan.Enabled = true;
            btnStop.Enabled = false;
            progressBar.Visible = false;
        }
    }

    private void ParseScanResults(string output)
    {
        // 简化解析：查找重复组
        var lines = output.Split('\n');
        var groups = new List<(string Dir, int Count, string Size)>();

        foreach (var line in lines)
        {
            if (line.Contains("发现") && line.Contains("组重复"))
            {
                // 解析统计信息
                lblSummary.Text = line.Trim();
            }
        }

        // 示例数据
        listResults.Items.Add(new ListViewItem(new[] { "示例目录", "3", "128 MB", "待处理" }));
        lblStatus.Text = "扫描完成";
        btnQuarantine.Enabled = true;
        btnDelete.Enabled = true;
        btnExport.Enabled = true;
    }
}
