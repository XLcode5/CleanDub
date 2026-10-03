using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CleanDub.Gui;

/// <summary>CleanDub 主窗口 —— 原生标题栏 + 纯色侧栏</summary>
public class MainForm : Form
{
    private readonly ScanEngine _engine = new();
    private ScanResult? _result;
    private CancellationTokenSource? _cts;
    private AppSettings _settings = new();
    private string SettingsFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CleanDub", "settings.json");

    // Chrome
    private Panel _sidebar = null!;
    private Panel _content = null!;
    private Label _lblPageTitle = null!;
    private readonly List<MacNavItem> _navItems = new();
    private readonly List<Control> _pages = new();
    private int _activeNav;

    // 扫描页
    private MacTextBox _txtPath = null!;
    private MacSegmented _segStrategy = null!;
    private MacSegmented _segVerify = null!;
    private MacToggle _tglRecurse = null!;
    private MacToggle _tglLinks = null!;
    private MacButton _btnScan = null!;
    private MacButton _btnStop = null!;
    private MacProgressBar _progress = null!;
    private Label _lblStatus = null!;
    private Panel _progressRow = null!;
    private ResultsList _listResults = null!;
    private MacButton _btnQuarantine = null!;
    private MacButton _btnExport = null!;
    private MacButton _btnDelete = null!;
    private Label _lblSummary = null!;
    private readonly StatCard[] _stats = new StatCard[4];
    private readonly System.Windows.Forms.Timer _progressTimer;
    // 历史页
    private HistoryList _lstHistory = null!;
    private MacSegmented _segHistoryFilter = null!;
    private Panel _historyEmpty = null!;
    private List<HistoryItem> _historyAll = new();

    // 隔离区页
    private QuarantineList _lstQuarantine = null!;
    private QuarantineManager? _qm;
    private Panel _quarEmpty = null!;
    private Label _lblQuarSummary = null!;
    private MacButton _btnRestore = null!;
    private MacButton _btnDeleteSelected = null!;
    private MacButton _btnPurge = null!;

    public MainForm()
    {
        DoubleBuffered = true;
        Text = "CleanDub";
        FormBorderStyle = FormBorderStyle.Sizable;
        Size = new Size(1080, 720);
        MinimumSize = new Size(920, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Font = MacTheme.F(9.5f);
        BackColor = MacTheme.WindowBg;

        LoadSettings();
        MacTheme.IsDark = _settings.DarkTheme;

        BuildChrome();
        BuildScanPage();
        BuildHistoryPage();
        BuildQuarantinePage();
        SwitchNav(0);
        ApplyTheme();

        // 扫描进度轮询：读取引擎 ProgressFile（每次覆盖写入的单行 JSON）
        _progressTimer = new System.Windows.Forms.Timer { Interval = 250 };
        _progressTimer.Tick += (s, e) => PollProgress();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // 原生标题栏，无需 DWM 自定义
    }

    // ==================== 框架 UI ====================
    private void BuildChrome()
    {
        // ---- 侧栏（纯色背景） ----
        _sidebar = new Panel { Width = 212, Dock = DockStyle.Left, BackColor = MacTheme.SidebarBg };
        Controls.Add(_sidebar);

        var logo = new Label
        {
            Text = "CleanDub",
            Font = MacTheme.F(14f, FontStyle.Bold),
            ForeColor = MacTheme.Ink,
            BackColor = Color.Transparent,
            Location = new Point(18, 22),
            Size = new Size(170, 26)
        };
        _sidebar.Controls.Add(logo);

        var logoSub = new Label
        {
            Text = "重复文件清理 · v0.5.0",
            Font = MacTheme.F(8f),
            ForeColor = MacTheme.Ink3,
            BackColor = Color.Transparent,
            Location = new Point(19, 48),
            Size = new Size(170, 16),
            Name = "muted"
        };
        _sidebar.Controls.Add(logoSub);

        string[] names = { "扫描", "历史", "隔离区" };
        string[] icons = { "search", "clock", "box" };
        for (int i = 0; i < names.Length; i++)
        {
            var nav = new MacNavItem
            {
                Label = names[i],
                IconName = icons[i],
                Location = new Point(10, 84 + i * 36),
                Size = new Size(192, 30),
                Tag = i
            };
            nav.Click += (s, e) => SwitchNav((int)((Control)s!).Tag!);
            _navItems.Add(nav);
            _sidebar.Controls.Add(nav);
        }

        // 侧栏底部：外观切换
        var bottom = new Panel { Height = 48, Dock = DockStyle.Bottom, BackColor = Color.Transparent };
        var themeIcon = new MacIconView
        {
            IconName = "moon",
            Location = new Point(22, 15),
            Size = new Size(16, 16),
            Name = "themeIcon"
        };
        var themeLbl = new Label
        {
            Text = "外观",
            Font = MacTheme.F(9f),
            ForeColor = MacTheme.Ink2,
            BackColor = Color.Transparent,
            Location = new Point(46, 14),
            Size = new Size(60, 20),
            Name = "muted"
        };
        var themeToggle = new MacToggle { Location = new Point(146, 10), Name = "themeToggle" };
        themeToggle.Checked = _settings.DarkTheme;
        themeToggle.CheckedChanged += (s, e) =>
        {
            _settings.DarkTheme = themeToggle.Checked;
            SaveSettings();
            MacTheme.IsDark = themeToggle.Checked;
            ApplyTheme();
        };
        bottom.Controls.Add(themeIcon);
        bottom.Controls.Add(themeLbl);
        bottom.Controls.Add(themeToggle);
        _sidebar.Controls.Add(bottom);

        // ---- 内容区 ----
        _content = new Panel { Dock = DockStyle.Fill, BackColor = MacTheme.WindowBg };
        Controls.Add(_content);
        _content.BringToFront();

        _lblPageTitle = new Label
        {
            Text = "扫描",
            Font = MacTheme.F(15f, FontStyle.Bold),
            ForeColor = MacTheme.Ink,
            BackColor = Color.Transparent,
            Location = new Point(24, 12),
            Size = new Size(300, 26)
        };
        _content.Controls.Add(_lblPageTitle);

        // ---- Windows 原生标题栏（FormBorderStyle.Sizable 自带） ----
        // 无需自定义 CaptionButtons
    }

    private void SwitchNav(int index)
    {
        _activeNav = index;
        string[] titles = { "扫描", "历史", "隔离区" };
        _lblPageTitle.Text = titles[index];
        for (int i = 0; i < _navItems.Count; i++)
            _navItems[i].Selected = i == index;
        for (int i = 0; i < _pages.Count; i++)
            _pages[i].Visible = i == index;
        if (index == 1) LoadHistory();
        if (index == 2) LoadQuarantine();
    }

    // ==================== 扫描页 ====================
    private void BuildScanPage()
    {
        var page = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent,
            Padding = new Padding(24, 46, 24, 18),
            AutoScroll = true
        };
        _pages.Add(page);
        _content.Controls.Add(page);

        int W() => Math.Max(640, page.ClientSize.Width - 48);

        // ---- 统计卡片 ----
        var statsRow = new FlowLayoutPanel
        {
            Location = new Point(24, 46),
            Height = 84,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            BackColor = Color.Transparent
        };
        (string label, string icon, Color tint)[] defs =
        {
            ("重复组", "copy", MacTheme.Accent),
            ("待处理文件", "doc", MacTheme.Warning),
            ("可释放空间", "chart", MacTheme.Success),
            ("扫描耗时", "clock", MacTheme.Purple)
        };
        for (int i = 0; i < 4; i++)
        {
            var stat = new StatCard(defs[i].label, defs[i].icon, defs[i].tint)
            {
                Size = new Size(190, 76),
                Margin = new Padding(0, 0, 12, 0)
            };
            _stats[i] = stat;
            statsRow.Controls.Add(stat);
        }
        page.Controls.Add(statsRow);

        // ---- 扫描设置卡片 ----
        var card = new MacCard { Location = new Point(24, 142), Size = new Size(700, 196) };
        page.Controls.Add(card);

        int cx = 22; // 卡片内左边距
        var lblPath = CardLabel(card, "扫描目录", cx, 16);

        _txtPath = new MacTextBox { Location = new Point(cx, 36), Size = new Size(500, 32) };
        _txtPath.TextValue = string.IsNullOrWhiteSpace(_settings.DefaultPath)
            ? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
            : _settings.DefaultPath;
        card.Controls.Add(_txtPath);

        var btnBrowse = new MacButton { Text = "浏览…", Location = new Point(508, 37), Size = new Size(84, 30) };
        btnBrowse.Click += (s, e) =>
        {
            using var dlg = new FolderBrowserDialog { Description = "选择扫描目录", SelectedPath = _txtPath.TextValue, UseDescriptionForTitle = true };
            if (dlg.ShowDialog() == DialogResult.OK) _txtPath.TextValue = dlg.SelectedPath;
        };
        card.Controls.Add(btnBrowse);

        var lblStrategy = CardLabel(card, "保留策略", cx, 80);
        _segStrategy = new MacSegmented
        {
            Location = new Point(cx, 100),
            Size = new Size(430, 30),
            Items = new[] { "名字最干净", "时间最新", "无后缀原件", "(N) 数字最大" },
            SelectedIndex = (int)_settings.Strategy
        };
        card.Controls.Add(_segStrategy);

        var lblVerify = CardLabel(card, "校验级别", cx + 452, 80);
        _segVerify = new MacSegmented
        {
            Location = new Point(cx + 452, 100),
            Size = new Size(180, 30),
            Items = new[] { "全量", "头部", "名称", "大小" },
            SelectedIndex = (int)_settings.Verify
        };
        card.Controls.Add(_segVerify);

        // 选项行
        _tglRecurse = new MacToggle { Location = new Point(cx, 144), Checked = _settings.Recurse };
        card.Controls.Add(_tglRecurse);
        var lblRecurse = CardLabel(card, "递归子目录", cx + 52, 148, true);
        _tglLinks = new MacToggle { Location = new Point(cx + 150, 144), Checked = _settings.DetectLinks };
        card.Controls.Add(_tglLinks);
        var lblLinks = CardLabel(card, "检测硬链接", cx + 202, 148, true);

        // 头部哈希大小（内联自原设置页）
        var lblHeadKB = CardLabel(card, "头部哈希(KB)", cx + 320, 148, true);
        var txtHeadKB = new MacTextBox { Location = new Point(cx + 410, 141), Size = new Size(60, 28) };
        txtHeadKB.TextValue = _settings.HeadKB.ToString();
        txtHeadKB.ValueChanged += (s, e) =>
        {
            if (int.TryParse(txtHeadKB.TextValue.Trim(), out int kb) && kb >= 1 && kb <= 4096)
            {
                _settings.HeadKB = kb;
                SaveSettings();
            }
        };
        card.Controls.Add(txtHeadKB);

        // 选项变更即时持久化
        _segStrategy.SelectedIndexChanged += (s, e) =>
        {
            _settings.Strategy = (RetentionStrategy)_segStrategy.SelectedIndex;
            SaveSettings();
        };
        _segVerify.SelectedIndexChanged += (s, e) =>
        {
            _settings.Verify = (VerifyLevel)_segVerify.SelectedIndex;
            SaveSettings();
        };
        _tglRecurse.CheckedChanged += (s, e) =>
        {
            _settings.Recurse = _tglRecurse.Checked;
            SaveSettings();
        };
        _tglLinks.CheckedChanged += (s, e) =>
        {
            _settings.DetectLinks = _tglLinks.Checked;
            SaveSettings();
        };

        _btnScan = new MacButton
        {
            Text = "开始扫描",
            Kind = MacBtnKind.Primary,
            Location = new Point(430, 141),
            Size = new Size(110, 34)
        };
        _btnScan.Click += async (s, e) => await StartScan();
        card.Controls.Add(_btnScan);

        _btnStop = new MacButton
        {
            Text = "停止",
            Kind = MacBtnKind.Destructive,
            Location = new Point(548, 141),
            Size = new Size(76, 34),
            Enabled = false
        };
        _btnStop.Click += (s, e) => { _engine.Stop(); _cts?.Cancel(); };
        card.Controls.Add(_btnStop);

        // ---- 进度行 ----
        _progressRow = new Panel { Location = new Point(24, 348), Height = 40, BackColor = Color.Transparent, Visible = false };
        _progress = new MacProgressBar { Location = new Point(2, 4), Size = new Size(600, 6) };
        _lblStatus = new Label
        {
            Location = new Point(2, 16),
            Size = new Size(600, 18),
            Font = MacTheme.F(8.5f),
            ForeColor = MacTheme.Ink2,
            BackColor = Color.Transparent,
            Name = "muted"
        };
        _progressRow.Controls.Add(_progress);
        _progressRow.Controls.Add(_lblStatus);
        page.Controls.Add(_progressRow);

        // ---- 结果列表 ----
        var lblResults = new Label
        {
            Text = "重复组明细",
            Font = MacTheme.F(11f, FontStyle.Bold),
            ForeColor = MacTheme.Ink,
            BackColor = Color.Transparent,
            Location = new Point(26, 352),
            Size = new Size(200, 22)
        };
        page.Controls.Add(lblResults);

        _listResults = new ResultsList { Location = new Point(24, 378), Size = new Size(700, 220) };
        _listResults.SelectionChanged += (s, e) => UpdateActionState();
        page.Controls.Add(_listResults);

        // ---- 底部操作行 ----
        var actionRow = new Panel { Location = new Point(24, 606), Height = 42, BackColor = Color.Transparent };
        _lblSummary = new Label
        {
            Text = "选择扫描目录后点击「开始扫描」",
            Location = new Point(2, 10),
            Size = new Size(360, 22),
            Font = MacTheme.F(9f),
            ForeColor = MacTheme.Ink2,
            BackColor = Color.Transparent,
            Name = "muted"
        };
        actionRow.Controls.Add(_lblSummary);

        _btnDelete = new MacButton { Text = "永久删除", Kind = MacBtnKind.DangerFill, Enabled = false, Size = new Size(96, 32) };
        _btnDelete.Click += async (s, e) => await RunCleanup(true);
        _btnQuarantine = new MacButton { Text = "移入隔离区", Kind = MacBtnKind.Primary, Enabled = false, Size = new Size(110, 32) };
        _btnQuarantine.Click += async (s, e) => await RunCleanup(false);
        _btnExport = new MacButton { Text = "导出 CSV", Kind = MacBtnKind.Normal, Enabled = false, Size = new Size(96, 32) };
        _btnExport.Click += async (s, e) => await ExportCsv();
        actionRow.Controls.Add(_btnDelete);
        actionRow.Controls.Add(_btnQuarantine);
        actionRow.Controls.Add(_btnExport);
        page.Controls.Add(actionRow);

        // ---- 响应式布局 ----
        void Relayout()
        {
            int w = W();
            statsRow.Width = w;
            statsRow.Height = 84;
            int cardW = (w - 36) / 4;
            for (int i = 0; i < 4; i++)
            {
                _stats[i].Width = cardW;
                _stats[i].Margin = new Padding(0, 0, i == 3 ? 0 : 12, 0);
            }

            card.Width = w;
            int iw = w - 44;
            _txtPath.Width = iw - 96;
            btnBrowse.Left = _txtPath.Right + 8;

            int half = (iw - 16) / 2;
            lblStrategy.Left = cx;
            _segStrategy.SetBounds(cx, 100, half, 30);
            lblVerify.Left = cx + half + 16;
            _segVerify.SetBounds(cx + half + 16, 100, iw - half - 16, 30);

            _btnStop.Left = card.Width - 24 - 110 - 84 - 10;
            _btnStop.Width = 84;
            _btnScan.Left = _btnStop.Left - 10 - 110;

            int py = card.Bottom + 12;
            _progressRow.SetBounds(24, py, w, 40);
            _progress.Width = w - 4;
            _lblStatus.Width = w - 4;
            lblResults.Top = py + (_progressRow.Visible ? 44 : 4);

            _listResults.SetBounds(24, lblResults.Bottom + 4, w, Math.Max(140, page.ClientSize.Height - lblResults.Bottom - 84));
            actionRow.SetBounds(24, _listResults.Bottom + 8, w, 42);

            _lblSummary.Width = w - 330;
            _btnExport.Left = w - 96;
            _btnQuarantine.Left = w - 96 - 10 - 110;
            _btnDelete.Left = w - 96 - 10 - 110 - 10 - 96;
            _btnExport.Top = _btnQuarantine.Top = _btnDelete.Top = 4;
        }
        page.Resize += (s, e) => Relayout();
        page.HandleCreated += (s, e) => BeginInvoke((Action)Relayout);
    }

    private static Label CardLabel(Control parent, string text, int x, int y, bool inline = false)
    {
        var lbl = new Label
        {
            Text = text,
            Font = MacTheme.F(8.5f, inline ? FontStyle.Regular : FontStyle.Bold),
            ForeColor = inline ? MacTheme.Ink : MacTheme.Ink2,
            BackColor = Color.Transparent,
            Location = new Point(x, y),
            Size = new Size(140, 18),
            Name = inline ? "body" : "muted"
        };
        parent.Controls.Add(lbl);
        return lbl;
    }

    // ==================== 历史页 ====================
    private void BuildHistoryPage()
    {
        var page = MakePage();

        // ---- 顶栏：类型筛选 + 刷新 ----
        var top = new Panel { Dock = DockStyle.Top, Height = 40, BackColor = Color.Transparent };
        _segHistoryFilter = new MacSegmented
        {
            Location = new Point(0, 5),
            Size = new Size(330, 28),
            Items = new[] { "全部", "扫描", "隔离", "还原", "删除" },
            SelectedIndex = 0
        };
        _segHistoryFilter.SelectedIndexChanged += (s, e) => ApplyHistoryFilter();
        top.Controls.Add(_segHistoryFilter);

        var btnRefresh = new MacButton { Text = "刷新", Size = new Size(76, 30), Location = new Point(340, 4) };
        btnRefresh.Click += (s, e) => LoadHistory();
        top.Controls.Add(btnRefresh);
        top.Resize += (s, e) => btnRefresh.Left = top.Width - btnRefresh.Width - 2;
        page.Controls.Add(top);

        // ---- 自绘历史列表 ----
        _lstHistory = new HistoryList { Dock = DockStyle.Fill };
        _lstHistory.ItemDoubleClick += (s, item) =>
        {
            if (item.LogDir.Length > 0 && Directory.Exists(item.LogDir))
                Process.Start(new ProcessStartInfo("explorer.exe", $"\"{item.LogDir}\"") { UseShellExecute = true });
            else
                Toast.Show(_content, "该记录没有关联的日志目录", ToastKind.Info);
        };
        page.Controls.Add(_lstHistory);
        _lstHistory.BringToFront();

        page.Controls.Add(MakeFooter(page, "双击记录可在资源管理器中打开日志目录"));

        // ---- 空状态（带 CTA） ----
        _historyEmpty = BuildHistoryEmpty(page);
    }

    private Panel BuildHistoryEmpty(Panel page)
    {
        var p = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Visible = false };
        var icon = new MacIconView { IconName = "clock", Size = new Size(40, 40), IconColor = MacTheme.Ink3, Stroke = 1.2f };
        var t = new Label
        {
            Text = "暂无操作记录",
            Font = MacTheme.F(12f, FontStyle.Bold),
            ForeColor = MacTheme.Ink3,
            BackColor = Color.Transparent,
            AutoSize = true,
            Name = "faint"
        };
        var s = new Label
        {
            Text = "完成一次扫描或清理后，记录会显示在这里",
            Font = MacTheme.F(9f),
            ForeColor = MacTheme.Ink3,
            BackColor = Color.Transparent,
            AutoSize = true,
            Name = "faint"
        };
        var cta = new MacButton
        {
            Text = "去扫描",
            Kind = MacBtnKind.Primary,
            Size = new Size(110, 32)
        };
        cta.Click += (s2, e) => SwitchNav(0);
        p.Controls.Add(icon);
        p.Controls.Add(t);
        p.Controls.Add(s);
        p.Controls.Add(cta);
        p.Resize += (sender, e) =>
        {
            icon.Left = (p.Width - icon.Width) / 2; icon.Top = p.Height / 2 - 88;
            t.Left = (p.Width - t.Width) / 2; t.Top = icon.Bottom + 12;
            s.Left = (p.Width - s.Width) / 2; s.Top = t.Bottom + 6;
            cta.Left = (p.Width - cta.Width) / 2; cta.Top = s.Bottom + 18;
        };
        page.Controls.Add(p);
        p.BringToFront();
        return p;
    }

    private void LoadHistory()
    {
        _historyAll = CleaningLog.Read(_txtPath.TextValue.Trim());
        ApplyHistoryFilter();
    }

    private void ApplyHistoryFilter()
    {
        // 分段：全部 / 扫描 / 隔离 / 还原 / 删除（删除含清空隔离区）
        IEnumerable<HistoryItem> filtered = _segHistoryFilter.SelectedIndex switch
        {
            1 => _historyAll.Where(h => h.Op == "scan"),
            2 => _historyAll.Where(h => h.Op == "quarantine"),
            3 => _historyAll.Where(h => h.Op == "restore"),
            4 => _historyAll.Where(h => h.Op == "purge" || h.Op == "delete"),
            _ => _historyAll
        };
        var list = filtered.ToList();
        _lstHistory.SetItems(list);
        _historyEmpty.Visible = list.Count == 0;
    }

    // ==================== 隔离区页 ====================
    private void BuildQuarantinePage()
    {
        var page = MakePage();

        // ---- 顶栏：汇总 + 操作按钮组 ----
        var top = new Panel { Dock = DockStyle.Top, Height = 44, BackColor = Color.Transparent };
        _lblQuarSummary = new Label
        {
            Dock = DockStyle.Left,
            Width = 380,
            Font = MacTheme.F(9.5f),
            ForeColor = MacTheme.Ink2,
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleLeft,
            Name = "muted"
        };
        _btnRestore = new MacButton { Text = "还原选中", Kind = MacBtnKind.Primary, Size = new Size(96, 30), Enabled = false };
        _btnRestore.Click += (s, e) => RestoreSelected();
        _btnDeleteSelected = new MacButton { Text = "删除选中", Kind = MacBtnKind.DangerFill, Size = new Size(96, 30), Enabled = false };
        _btnDeleteSelected.Click += (s, e) => DeleteSelected();
        _btnPurge = new MacButton { Text = "全部清空", Kind = MacBtnKind.Destructive, Size = new Size(96, 30), Enabled = false };
        _btnPurge.Click += (s, e) => PurgeAll();
        var btnOpen = new MacButton { Text = "打开目录", Size = new Size(88, 30) };
        btnOpen.Click += (s, e) =>
        {
            var q = QuarantineDir();
            if (Directory.Exists(q))
                Process.Start(new ProcessStartInfo("explorer.exe", $"\"{q}\"") { UseShellExecute = true });
            else
                MacAlert.Info(this, "隔离区为空", "当前扫描目录下还没有隔离区。");
        };
        var btnRefresh = new MacButton { Text = "刷新", Size = new Size(76, 30) };
        btnRefresh.Click += (s, e) => LoadQuarantine();

        top.Controls.Add(_btnRestore);
        top.Controls.Add(_btnDeleteSelected);
        top.Controls.Add(_btnPurge);
        top.Controls.Add(btnRefresh);
        top.Controls.Add(btnOpen);
        top.Controls.Add(_lblQuarSummary);
        top.Resize += (s, e) =>
        {
            btnRefresh.Left = top.Width - btnRefresh.Width - 4;
            btnOpen.Left = btnRefresh.Left - btnOpen.Width - 8;
            _btnPurge.Left = btnOpen.Left - _btnPurge.Width - 8;
            _btnDeleteSelected.Left = _btnPurge.Left - _btnDeleteSelected.Width - 8;
            _btnRestore.Left = _btnDeleteSelected.Left - _btnRestore.Width - 8;
            _lblQuarSummary.Width = Math.Max(120, _btnRestore.Left - 12);
        };
        top.Resize += (s, e) => { foreach (Control c in top.Controls) if (c != _lblQuarSummary) c.Top = 7; };
        page.Controls.Add(top);

        _lstQuarantine = new QuarantineList { Dock = DockStyle.Fill };
        _lstQuarantine.SelectionChanged += (s, e) => UpdateQuarButtons();
        page.Controls.Add(_lstQuarantine);
        _lstQuarantine.BringToFront();
        page.Controls.Add(MakeFooter(page, "勾选后可还原到原位置或永久删除；还原时若原路径被占用会自动加 .restored 后缀"));

        _quarEmpty = EmptyLabelPanel(page, "隔离区为空", "在扫描结果中勾选冗余文件，点击「移入隔离区」后会出现在这里");
    }

    private string QuarantineDir() => Path.Combine(_txtPath.TextValue, "_dedup_quarantine");

    private void LoadQuarantine()
    {
        var root = _txtPath.TextValue.Trim();
        _qm = Directory.Exists(root) ? new QuarantineManager(root) : null;
        var sessions = _qm?.LoadSessions() ?? new List<QuarantineSession>();
        _lstQuarantine.SetSessions(sessions);

        int count = sessions.Sum(s => s.Files.Count);
        long total = sessions.Sum(s => s.TotalBytes);
        _lblQuarSummary.Text = count == 0
            ? "隔离区位于扫描目录下的 _dedup_quarantine"
            : $"{sessions.Count} 个会话 · 共 {count} 个文件 · {FormatSize(total)}";
        _quarEmpty.Visible = count == 0;
        _lstQuarantine.Visible = count > 0;
        UpdateQuarButtons();
    }

    private void UpdateQuarButtons()
    {
        bool hasSel = _lstQuarantine.SelectedCount > 0;
        _btnRestore.Enabled = hasSel;
        _btnDeleteSelected.Enabled = hasSel;
        _btnPurge.Enabled = _qm != null && _lstQuarantine.Visible;
        if (hasSel)
            _lblQuarSummary.Text = $"已选 {_lstQuarantine.SelectedCount} 个文件 · {FormatSize(_lstQuarantine.SelectedBytes)}";
    }

    private void RestoreSelected()
    {
        if (_qm == null) return;
        var sel = _lstQuarantine.SelectedEntries();
        if (sel.Count == 0) return;
        if (!MacAlert.Confirm(this, "还原文件",
                $"将把 {sel.Count} 个文件还原到原始位置（{FormatSize(_lstQuarantine.SelectedBytes)}）。",
                "还原", "取消", false))
            return;

        int moved = 0; var failures = new List<(string, string)>();
        foreach (var grp in sel.GroupBy(x => x.Session))
        {
            var r = _qm.Restore(grp.Key, grp.Select(x => x.Entry));
            moved += r.Moved;
            failures.AddRange(r.Failures);
        }
        LoadQuarantine();
        Toast.Show(_content, $"已还原 {moved} 个文件", moved > 0 ? ToastKind.Success : ToastKind.Error);
        if (failures.Count > 0)
            MacAlert.Info(this, "部分还原失败", string.Join("\n", failures.Take(5).Select(f => $"{f.Item1}\n  {f.Item2}")));
    }

    private void DeleteSelected()
    {
        if (_qm == null) return;
        var sel = _lstQuarantine.SelectedEntries();
        if (sel.Count == 0) return;
        if (!MacAlert.Confirm(this, "永久删除",
                $"将永久删除隔离区中选中的 {sel.Count} 个文件（{FormatSize(_lstQuarantine.SelectedBytes)}）。\n此操作不可撤销，确定继续吗？",
                "永久删除", "取消", true))
            return;

        int moved = 0; var failures = new List<(string, string)>();
        foreach (var grp in sel.GroupBy(x => x.Session))
        {
            var r = _qm.Delete(grp.Key, grp.Select(x => x.Entry));
            moved += r.Moved;
            failures.AddRange(r.Failures);
        }
        LoadQuarantine();
        Toast.Show(_content, $"已永久删除 {moved} 个文件", moved > 0 ? ToastKind.Success : ToastKind.Error);
        if (failures.Count > 0)
            MacAlert.Info(this, "部分删除失败", string.Join("\n", failures.Take(5).Select(f => $"{f.Item1}\n  {f.Item2}")));
    }

    private void PurgeAll()
    {
        if (_qm == null) return;
        if (!MacAlert.Confirm(this, "清空隔离区",
                "将永久删除隔离区中的全部文件。\n此操作不可撤销，确定继续吗？",
                "全部清空", "取消", true))
            return;

        var r = _qm.PurgeAll();
        LoadQuarantine();
        Toast.Show(_content, $"隔离区已清空（{r.Moved} 个文件）", ToastKind.Success);
    }

    // ==================== 页面辅助 ====================
    private Panel MakePage()
    {
        var page = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent,
            Padding = new Padding(24, 50, 24, 16),
            Visible = false
        };
        _pages.Add(page);
        _content.Controls.Add(page);
        return page;
    }

    /// <summary>空状态面板（返回 Panel，用 Visible 控制整体显隐）。默认隐藏。</summary>
    private Panel EmptyLabelPanel(Control parent, string title, string sub)
    {
        var p = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Visible = false };
        var t = new Label
        {
            Text = title,
            Font = MacTheme.F(12f, FontStyle.Bold),
            ForeColor = MacTheme.Ink3,
            BackColor = Color.Transparent,
            AutoSize = true,
            Name = "muted"
        };
        var s = new Label
        {
            Text = sub,
            Font = MacTheme.F(9f),
            ForeColor = MacTheme.Ink3,
            BackColor = Color.Transparent,
            AutoSize = true,
            Name = "muted"
        };
        p.Controls.Add(t);
        p.Controls.Add(s);
        p.Resize += (sender, e) =>
        {
            t.Left = (p.Width - t.Width) / 2; t.Top = p.Height / 2 - 34;
            s.Left = (p.Width - s.Width) / 2; s.Top = t.Bottom + 6;
        };
        parent.Controls.Add(p);
        p.BringToFront();
        return p;
    }

    private Label MakeFooter(Panel page, string text)
    {
        var lbl = new Label
        {
            Text = text,
            Dock = DockStyle.Bottom,
            Height = 24,
            Font = MacTheme.F(8.5f),
            ForeColor = MacTheme.Ink3,
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleLeft,
            Name = "muted"
        };
        return lbl;
    }

    // ==================== 主题 ====================
    private void ApplyTheme()
    {
        BackColor = MacTheme.WindowBg;
        _content.BackColor = MacTheme.WindowBg;
        _lblPageTitle.ForeColor = MacTheme.Ink;
        ApplyThemeRecursive(this);
        _sidebar.Invalidate(true); // 纯色侧栏随主题切换
        // 原生标题栏，无需 DWM 暗色模式同步
        Invalidate(true);
    }

    private static void ApplyThemeRecursive(Control c)
    {
        switch (c)
        {
            case Label lbl:
                lbl.ForeColor = lbl.Name switch
                {
                    "muted" => MacTheme.Ink2,
                    "faint" => MacTheme.Ink3,
                    _ => MacTheme.Ink
                };
                break;
            case HistoryList hl:
                hl.BackColor = MacTheme.WindowBg;
                hl.RefreshTheme();
                break;
            case QuarantineList ql:
                ql.BackColor = MacTheme.WindowBg;
                ql.RefreshTheme();
                break;
            case ResultsList rl:
                rl.BackColor = MacTheme.WindowBg;
                rl.RefreshTheme();
                break;
            case MacTextBox mtb:
                mtb.ApplyTheme();
                break;
            case MacCard card:
                card.BackColor = MacTheme.WindowBg;
                break;
        }
        foreach (Control child in c.Controls)
            ApplyThemeRecursive(child);
        c.Invalidate();
    }

    // ==================== 扫描流程 ====================
    private (RetentionStrategy, VerifyLevel) CurrentOptions() =>
        ((RetentionStrategy)_segStrategy.SelectedIndex, (VerifyLevel)_segVerify.SelectedIndex);

    private async Task StartScan()
    {
        var path = _txtPath.TextValue.Trim();
        if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
        {
            MacAlert.Info(this, "目录无效", "请选择一个存在的扫描目录。");
            return;
        }

        _settings.DefaultPath = path;
        SaveSettings();

        SetBusy(true);
        _progress.Value = 0;
        _listResults.SetGroups(Array.Empty<DuplicateGroup>());
        foreach (var s in _stats) s.ValueText = "…";

        _cts = new CancellationTokenSource();
        var (strategy, verify) = CurrentOptions();
        var progress = new Progress<ScanProgress>(p =>
        {
            _lblStatus.Text = p.Phase == ScanPhase.Completed
                ? $"完成 · {p.TotalGroups} 组 · {p.TotalVictims} 个待处理"
                : p.PhaseLabel;
            if (p.Phase == ScanPhase.Completed)
            {
                _progress.Indeterminate = false;
                _progress.Value = 100;
            }
        });

        _progressTimer.Start();
        try
        {
            _result = await _engine.ScanAsync(path, strategy, verify,
                _tglLinks.Checked, _settings.HeadKB, progress, _cts.Token, _tglRecurse.Checked);
        }
        catch (Exception ex)
        {
            MacAlert.Info(this, "扫描出错", ex.Message);
        }
        finally
        {
            _progressTimer.Stop();
        }

        SetBusy(false);

        if (_result != null)
        {
            _stats[0].ValueText = _result.TotalGroups.ToString("N0");
            _stats[1].ValueText = _result.TotalVictims.ToString("N0");
            _stats[2].ValueText = _result.RealLabel;
            _stats[3].ValueText = _result.ElapsedLabel;

            _listResults.SetGroups(_result.Groups);
            UpdateActionState();
        }
    }

    /// <summary>轮询引擎进度文件，驱动确定性进度条与阶段文案。</summary>
    private void PollProgress()
    {
        var file = _engine.CurrentProgressFile;
        if (file == null || !File.Exists(file)) return;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var r = doc.RootElement;
            string phase = r.TryGetProperty("phase", out var ph) ? ph.GetString() ?? "" : "";
            string msg = r.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
            double pct = r.TryGetProperty("percent", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetDouble() : 0;

            // 阶段权重：索引 0-10 · 大小分组 10-20 · 预哈希 20-60 · 全量哈希 60-95
            var (basePct, span) = phase switch
            {
                "indexing" => (0.0, 10.0),
                "sizing" => (10.0, 10.0),
                "prehash" => (20.0, 40.0),
                "fullhash" => (60.0, 35.0),
                _ => (0.0, 0.0)
            };
            if (span > 0)
            {
                _progress.Indeterminate = false;
                _progress.Value = (int)(basePct + pct / 100.0 * span);
            }
            if (msg.Length > 0)
                _lblStatus.Text = $"{msg} · {pct:F0}%";
        }
        catch { /* 引擎正在写入进度文件，下一拍再读 */ }
    }

    /// <summary>按勾选状态联动操作按钮与底部汇总。</summary>
    private void UpdateActionState()
    {
        int n = _listResults.SelectedCount;
        long bytes = _listResults.SelectedBytes;
        int groups = _listResults.Groups.Count;
        _btnQuarantine.Enabled = n > 0;
        _btnDelete.Enabled = n > 0;
        _btnExport.Enabled = groups > 0;

        if (n > 0)
            _lblSummary.Text = $"已选 {n} 个冗余文件 · 可释放 {FormatSize(bytes)}";
        else if (groups > 0)
            _lblSummary.Text = $"{groups} 组重复 · 展开并勾选冗余文件后可移入隔离区或删除";
        else if (_result != null)
            _lblSummary.Text = "未发现重复文件";
        else
            _lblSummary.Text = "选择扫描目录后点击「开始扫描」";
    }

    private void SetBusy(bool busy)
    {
        _btnScan.Enabled = !busy;
        _btnStop.Enabled = busy;
        _progressRow.Visible = busy;
        if (busy)
        {
            _progress.Indeterminate = true;
            _btnQuarantine.Enabled = _btnDelete.Enabled = _btnExport.Enabled = false;
        }
        _lblStatus.Text = busy ? "正在扫描…" : "";
    }

    // ==================== 清理动作 ====================
    /// <summary>对勾选文件直接执行清理（不再重跑引擎扫描）。permanent=true 永久删除，false 移入隔离区。</summary>
    private async Task RunCleanup(bool permanent)
    {
        var root = _txtPath.TextValue.Trim();
        var selected = _listResults.SelectedVictims();
        if (selected.Count == 0 || !Directory.Exists(root)) return;

        long bytes = selected.Sum(v => v.Size);
        string title = permanent ? "永久删除重复文件" : "移入隔离区";
        string msg = permanent
            ? $"将永久删除勾选的 {selected.Count} 个文件（{FormatSize(bytes)}）。\n此操作不可撤销，确定继续吗？"
            : $"将把勾选的 {selected.Count} 个文件移入隔离区（{FormatSize(bytes)}），可随时还原。\n确定继续吗？";

        if (!MacAlert.Confirm(this, title, msg, permanent ? "永久删除" : "移入隔离区", "取消", permanent))
            return;

        _btnQuarantine.Enabled = _btnDelete.Enabled = false;
        var donePaths = new List<string>();
        var failures = new List<(string Path, string Reason)>();

        if (permanent)
        {
            await Task.Run(() =>
            {
                long freed = 0;
                string rootFull = Path.GetFullPath(root);
                foreach (var v in selected)
                {
                    try
                    {
                        var full = Path.GetFullPath(v.FullPath);
                        // 幂等安全：只允许处理扫描根内的文件
                        if (!full.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        { failures.Add((v.FullPath, "不在扫描根目录内，已拒绝")); continue; }
                        File.Delete(full);
                        donePaths.Add(v.FullPath);
                        freed += v.Size;
                    }
                    catch (Exception ex) { failures.Add((v.FullPath, ex.Message)); }
                }
                if (donePaths.Count > 0)
                    CleaningLog.Append(root, "delete", $"永久删除 {donePaths.Count} 个文件（{FormatSize(freed)}）", donePaths.Count, freed);
            });
        }
        else
        {
            await Task.Run(() =>
            {
                var r = new QuarantineManager(root).MoveToQuarantine(selected);
                foreach (var v in selected)
                    if (!r.Failures.Any(f => f.Item1 == v.FullPath))
                        donePaths.Add(v.FullPath);
                failures.AddRange(r.Failures);
            });
        }

        _listResults.RemoveProcessed(donePaths);
        RefreshStatsFromList();
        UpdateActionState();
        Toast.Show(_content,
            permanent ? $"已永久删除 {donePaths.Count} 个文件" : $"已移入隔离区 {donePaths.Count} 个文件",
            failures.Count == 0 ? ToastKind.Success : ToastKind.Info);
        if (failures.Count > 0)
            MacAlert.Info(this, "部分文件处理失败",
                string.Join("\n", failures.Take(5).Select(f => $"{f.Path}\n  {f.Reason}")));
    }

    /// <summary>清理后按剩余组刷新统计卡片。</summary>
    private void RefreshStatsFromList()
    {
        var groups = _listResults.Groups;
        _stats[0].ValueText = groups.Count.ToString("N0");
        _stats[1].ValueText = groups.Sum(g => g.Victims.Count).ToString("N0");
        _stats[2].ValueText = FormatSize(groups.Sum(g => g.ReclaimableBytes));
    }

    private async Task ExportCsv()
    {
        using var dlg = new SaveFileDialog
        {
            Filter = "CSV 文件|*.csv",
            FileName = $"dedup-plan-{DateTime.Now:yyyyMMdd-HHmm}.csv",
            Title = "导出清理计划"
        };
        if (dlg.ShowDialog() != DialogResult.OK) return;

        SetBusy(true);
        var (strategy, verify) = CurrentOptions();
        var file = await _engine.ExportCsvAsync(_txtPath.TextValue.Trim(), dlg.FileName,
            strategy, verify, _tglLinks.Checked, _tglRecurse.Checked, _settings.HeadKB);
        SetBusy(false);

        if (file != null)
            MacAlert.Info(this, "导出成功", $"清理计划已保存到：\n{file}");
        else
            MacAlert.Info(this, "导出失败", "未能生成 CSV 文件，请检查目录权限。");
    }

    // ==================== 设置持久化 ====================
    private void LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsFile))
                _settings = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsFile)) ?? new AppSettings();
        }
        catch { _settings = new AppSettings(); }
    }

    private void SaveSettings()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile)!);
            File.WriteAllText(SettingsFile, JsonSerializer.Serialize(_settings, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    private static string FormatSize(long bytes)
    {
        if (bytes >= 1073741824) return $"{bytes / 1073741824.0:F2} GB";
        if (bytes >= 1048576) return $"{bytes / 1048576.0:F1} MB";
        if (bytes >= 1024) return $"{bytes / 1024.0:F1} KB";
        return $"{bytes} B";
    }
}

// ==================== 统计卡片 ====================
public class StatCard : MacCard
{
    private readonly string _label;
    private readonly string _icon;
    private readonly Color _tint;
    private string _value = "—";

    public string ValueText
    {
        get => _value;
        set { _value = value; Invalidate(); }
    }

    public StatCard(string label, string icon, Color tint)
    {
        _label = label; _icon = icon; _tint = tint;
        Radius = 10f;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        Gfx.Smooth(g);
        var face = FaceRect;

        // 图标底块
        var tile = new RectangleF(face.X + 12, face.Y + (face.Height - 34) / 2, 34, 34);
        using (var tb = new SolidBrush(MacTheme.Alpha(_tint, MacTheme.IsDark ? 46 : 22)))
            Gfx.FillRounded(g, tb, tile, 8);
        MacIcons.Draw(g, _icon, new RectangleF(tile.X + 8, tile.Y + 8, 18, 18), _tint, 1.6f);

        // 文字
        using var lf = MacTheme.F(8.5f);
        TextRenderer.DrawText(g, _label, lf,
            new Rectangle((int)(tile.Right + 10), (int)(face.Y + 14), (int)(face.Width - tile.Width - 34), 16),
            MacTheme.Ink2, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        using var vf = MacTheme.F(13f, FontStyle.Bold);
        TextRenderer.DrawText(g, _value, vf,
            new Rectangle((int)(tile.Right + 10), (int)(face.Y + 32), (int)(face.Width - tile.Width - 34), 24),
            MacTheme.Ink, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
    }
}

// ==================== 结果列表（自绘，行 = 重复组） ====================
/// <summary>
/// 扫描结果列表：组行（展开箭头 + 三态组复选框）+ 展开后的文件行（victim 复选框 / keeper 标记）。
/// 勾选状态存放在 DuplicateFile.Selected，清理动作只作用于勾选项。
/// </summary>
public class ResultsList : Control
{
    private const int GroupH = 50;
    private const int FileH = 32;
    private const int HeaderH = 30;
    private readonly List<DuplicateGroup> _groups = new();
    private readonly List<object> _rows = new(); // DuplicateGroup | (DuplicateGroup, DuplicateFile)
    private int _scroll;
    private int _hover = -1;
    private readonly VScrollBar _scrollBar;

    public event EventHandler? SelectionChanged;

    public ResultsList()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = MacTheme.WindowBg;

        _scrollBar = new VScrollBar { Dock = DockStyle.Right, Width = 12, Visible = false };
        _scrollBar.Scroll += (s, e) => { _scroll = _scrollBar.Value; Invalidate(); };
        Controls.Add(_scrollBar);
    }

    public IReadOnlyList<DuplicateGroup> Groups => _groups;
    public int SelectedCount { get; private set; }
    public long SelectedBytes { get; private set; }

    public void SetGroups(IEnumerable<DuplicateGroup> groups)
    {
        _groups.Clear();
        _groups.AddRange(groups);
        _scroll = 0;
        RebuildRows();
    }

    /// <summary>当前所有勾选的冗余文件。</summary>
    public List<DuplicateFile> SelectedVictims() =>
        _groups.SelectMany(g => g.Victims.Where(v => v.Selected)).ToList();

    /// <summary>清理完成后从列表移除已处理的文件；组空了就移除组。</summary>
    public void RemoveProcessed(IEnumerable<string> paths)
    {
        var done = new HashSet<string>(paths, StringComparer.OrdinalIgnoreCase);
        for (int gi = _groups.Count - 1; gi >= 0; gi--)
        {
            var g = _groups[gi];
            long freed = 0;
            int removed = g.Victims.RemoveAll(v =>
            {
                if (!done.Contains(v.FullPath)) return false;
                freed += v.Size;
                return true;
            });
            if (removed > 0)
            {
                g.ReclaimableBytes = Math.Max(0, g.ReclaimableBytes - freed);
                g.FileCount = g.Victims.Count + (g.KeeperPath.Length > 0 ? 1 : 0);
            }
            if (g.Victims.Count == 0) _groups.RemoveAt(gi);
        }
        RebuildRows();
    }

    public void RefreshTheme()
    {
        UpdateScroll();
        Invalidate();
    }

    private void RebuildRows()
    {
        _rows.Clear();
        foreach (var g in _groups)
        {
            _rows.Add(g);
            if (!g.Expanded) continue;
            // keeper 排在最前（不可勾选），随后是 victims
            if (g.KeeperPath.Length > 0)
                _rows.Add((g, new DuplicateFile { FullPath = g.KeeperPath, IsKeeper = true }));
            foreach (var v in g.Victims) _rows.Add((g, v));
        }
        RecountSelection();
        UpdateScroll();
        Invalidate();
    }

    private void RecountSelection()
    {
        SelectedCount = _groups.Sum(g => g.Victims.Count(v => v.Selected));
        SelectedBytes = _groups.Sum(g => g.Victims.Where(v => v.Selected).Sum(v => v.Size));
    }

    private int TotalHeight()
    {
        int h = HeaderH;
        foreach (var r in _rows) h += r is DuplicateGroup ? GroupH : FileH;
        return h;
    }

    private void UpdateScroll()
    {
        int total = TotalHeight();
        int view = Height;
        _scrollBar.Visible = total > view;
        if (_scrollBar.Visible)
        {
            _scrollBar.Minimum = 0;
            _scrollBar.Maximum = Math.Max(0, total - view + GroupH);
            _scrollBar.LargeChange = view;
            _scrollBar.SmallChange = FileH;
            _scroll = Math.Min(_scroll, _scrollBar.Maximum);
        }
        else _scroll = 0;
    }

    protected override void OnResize(EventArgs e) { UpdateScroll(); base.OnResize(e); }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        if (_scrollBar.Visible)
        {
            _scroll = Math.Clamp(_scroll - Math.Sign(e.Delta) * GroupH, 0, _scrollBar.Maximum);
            _scrollBar.Value = _scroll;
            Invalidate();
        }
        base.OnMouseWheel(e);
    }

    /// <summary>命中测试：返回扁平行索引与该行顶部 Y。</summary>
    private int HitRow(int y, out int rowTop, out int rowH)
    {
        int acc = HeaderH - _scroll;
        for (int i = 0; i < _rows.Count; i++)
        {
            int h = _rows[i] is DuplicateGroup ? GroupH : FileH;
            if (y >= acc && y < acc + h) { rowTop = acc; rowH = h; return i; }
            acc += h;
        }
        rowTop = 0; rowH = 0;
        return -1;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        int idx = HitRow(e.Y, out _, out _);
        if (idx != _hover) { _hover = idx; Invalidate(); }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e) { _hover = -1; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        int idx = HitRow(e.Y, out _, out _);
        if (idx >= 0)
        {
            if (_rows[idx] is DuplicateGroup g)
            {
                if (e.X < 30) // 箭头区：展开/折叠
                {
                    g.Expanded = !g.Expanded;
                    RebuildRows();
                }
                else if (e.X < 56) // 组复选框：整组勾选/取消
                {
                    bool target = g.Victims.Any(v => !v.Selected);
                    foreach (var v in g.Victims) v.Selected = target;
                    RecountSelection();
                    Invalidate();
                    SelectionChanged?.Invoke(this, EventArgs.Empty);
                }
            }
            else if (_rows[idx] is ValueTuple<DuplicateGroup, DuplicateFile> pair && !pair.Item2.IsKeeper)
            {
                if (e.X >= 30 && e.X < 56)
                {
                    pair.Item2.Selected = !pair.Item2.Selected;
                    RecountSelection();
                    Invalidate();
                    SelectionChanged?.Invoke(this, EventArgs.Empty);
                }
            }
        }
        base.OnMouseClick(e);
    }

    private static void DrawCheck(Graphics g, RectangleF rc, bool? state)
    {
        using var pen = new Pen(state == false ? MacTheme.Ink3 : MacTheme.Accent, 1.4f);
        if (state == true || state == null)
        {
            using var fill = new SolidBrush(MacTheme.Accent);
            Gfx.FillRounded(g, fill, rc, 4);
        }
        else Gfx.DrawRounded(g, pen, rc, 4);

        if (state == true)
            MacIcons.Draw(g, "check", new RectangleF(rc.X + 2.5f, rc.Y + 2.5f, rc.Width - 5, rc.Height - 5),
                Color.White, 1.8f);
        else if (state == null)
        {
            using var wb = new SolidBrush(Color.White);
            g.FillRectangle(wb, rc.X + 3, rc.Y + rc.Height / 2 - 1, rc.Width - 6, 2);
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        int w = Width - (_scrollBar.Visible ? _scrollBar.Width : 0);

        // 表头
        using (var hb = new SolidBrush(MacTheme.TrackFill))
            g.FillRectangle(hb, 0, 0, w, HeaderH);
        using (var hf = MacTheme.F(8.5f, FontStyle.Bold))
        {
            TextRenderer.DrawText(g, "目录 / 文件", hf, new Rectangle(60, 0, w - 360, HeaderH), MacTheme.Ink2,
                TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(g, "文件", hf, new Rectangle(w - 300, 0, 64, HeaderH), MacTheme.Ink2,
                TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
            TextRenderer.DrawText(g, "可释放", hf, new Rectangle(w - 230, 0, 90, HeaderH), MacTheme.Ink2,
                TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
            TextRenderer.DrawText(g, "保留", hf, new Rectangle(w - 130, 0, 118, HeaderH), MacTheme.Ink2,
                TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }

        if (_groups.Count == 0)
        {
            using var ef = MacTheme.F(9.5f);
            TextRenderer.DrawText(g, "尚无结果 — 扫描完成后重复组会显示在这里", ef,
                new Rectangle(0, HeaderH, w, Height - HeaderH), MacTheme.Ink3,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            return;
        }

        using var nameF = MacTheme.F(9.5f);
        using var subF = MacTheme.F(8f);
        using var boldF = MacTheme.F(9.5f, FontStyle.Bold);

        int y = HeaderH - _scroll;
        for (int i = 0; i < _rows.Count; i++)
        {
            if (_rows[i] is DuplicateGroup grp)
            {
                if (y + GroupH >= HeaderH && y <= Height)
                {
                    if (i == _hover)
                    {
                        using var hv = new SolidBrush(MacTheme.HoverPill);
                        g.FillRectangle(hv, 0, y, w, GroupH);
                    }

                    // 展开箭头
                    using (var pen = new Pen(MacTheme.Ink3, 1.5f))
                    {
                        float cx = 16, cy = y + GroupH / 2f;
                        if (grp.Expanded)
                            g.DrawLines(pen, new[] { new PointF(cx - 4, cy - 2), new PointF(cx, cy + 2), new PointF(cx + 4, cy - 2) });
                        else
                            g.DrawLines(pen, new[] { new PointF(cx - 2, cy - 4), new PointF(cx + 2, cy), new PointF(cx - 2, cy + 4) });
                    }

                    // 组复选框（三态：按 victim 勾选情况）
                    bool? state = grp.Victims.Count == 0 ? false :
                                  grp.Victims.All(v => v.Selected) ? true :
                                  grp.Victims.Any(v => v.Selected) ? null : false;
                    DrawCheck(g, new RectangleF(36, y + GroupH / 2f - 8, 16, 16), state);

                    int tx = 62;
                    int dirW = w - tx - 320;
                    TextRenderer.DrawText(g, grp.Directory, boldF,
                        new Rectangle(tx, y + 7, dirW, 20), MacTheme.Ink,
                        TextFormatFlags.EndEllipsis | TextFormatFlags.PathEllipsis);
                    string sub = grp.Victims.Count > 0
                        ? $"{grp.Victims.Count} 个冗余 · 保留 {Path.GetFileName(grp.KeeperPath)}" + (grp.IsHardLinked ? " · 含硬链接" : "")
                        : "完整重复组";
                    TextRenderer.DrawText(g, sub, subF,
                        new Rectangle(tx, y + 28, dirW, 16), MacTheme.Ink2, TextFormatFlags.EndEllipsis);

                    TextRenderer.DrawText(g, grp.FileCount.ToString(), nameF,
                        new Rectangle(w - 300, y, 64, GroupH), MacTheme.Ink,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                    TextRenderer.DrawText(g, grp.ReclaimableLabel, nameF,
                        new Rectangle(w - 230, y, 90, GroupH), MacTheme.Success,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                    TextRenderer.DrawText(g, Path.GetFileName(grp.KeeperPath), subF,
                        new Rectangle(w - 130, y, 118, GroupH), MacTheme.Ink2,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);

                    using var sep = new Pen(MacTheme.Separator, 1f);
                    g.DrawLine(sep, tx, y + GroupH - 1, w - 12, y + GroupH - 1);
                }
                y += GroupH;
            }
            else if (_rows[i] is ValueTuple<DuplicateGroup, DuplicateFile> pair)
            {
                var file = pair.Item2;
                if (y + FileH >= HeaderH && y <= Height)
                {
                    if (i == _hover)
                    {
                        using var hv = new SolidBrush(MacTheme.HoverPill);
                        g.FillRectangle(hv, 30, y, w - 30, FileH);
                    }

                    if (file.IsKeeper)
                    {
                        // 保留标记：绿色小胶囊
                        var badge = new RectangleF(32, y + FileH / 2f - 8, 32, 16);
                        using (var bb = new SolidBrush(MacTheme.Alpha(MacTheme.Success, MacTheme.IsDark ? 46 : 24)))
                            Gfx.FillRounded(g, bb, badge, 8);
                        using (var bf = MacTheme.F(7.5f))
                            TextRenderer.DrawText(g, "保留", bf,
                                new Rectangle((int)badge.X, (int)badge.Y, (int)badge.Width, (int)badge.Height),
                                MacTheme.Success, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                    }
                    else
                        DrawCheck(g, new RectangleF(36, y + FileH / 2f - 8, 16, 16), file.Selected);

                    MacIcons.Draw(g, "doc", new RectangleF(72, y + FileH / 2f - 7, 14, 14),
                        file.IsKeeper ? MacTheme.Success : MacTheme.Ink3, 1.4f);

                    TextRenderer.DrawText(g, file.FileName, nameF,
                        new Rectangle(94, y, w - 94 - 250, FileH),
                        file.IsKeeper ? MacTheme.Ink : MacTheme.Ink,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
                    TextRenderer.DrawText(g, file.SizeLabel, subF,
                        new Rectangle(w - 220, y, 90, FileH), MacTheme.Ink2,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.Right);
                    TextRenderer.DrawText(g, file.LastWriteTime == default ? "" : file.LastWriteTime.ToString("MM-dd HH:mm"), subF,
                        new Rectangle(w - 120, y, 106, FileH), MacTheme.Ink3,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.Right);
                }
                y += FileH;
            }
        }
    }
}
