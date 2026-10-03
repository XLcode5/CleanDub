using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CleanDub.Gui;

// ==================== Windows 风格窗口按钮（最小化 / 最大化·还原 / 关闭） ====================
public class CaptionButtons : Control
{
    public event EventHandler? CloseClick;
    public event EventHandler? MinClick;
    public event EventHandler? MaxClick;

    private const int BtnW = 46;
    private int _hover = -1;
    private int _pressed = -1;
    private bool _maximized;

    /// <summary>切换 最大化 / 还原 两种图标</summary>
    public bool IsMaximized
    {
        get => _maximized;
        set { _maximized = value; Invalidate(); }
    }

    public CaptionButtons()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                 ControlStyles.SupportsTransparentBackColor, true);
        Size = new Size(BtnW * 3, 32);
        BackColor = Color.Transparent;
    }

    private Rectangle BtnRect(int i) => new(i * BtnW, 0, BtnW, Height);

    private int HitTest(Point p) =>
        p.X < 0 || p.Y < 0 || p.Y >= Height || p.X >= BtnW * 3 ? -1 : p.X / BtnW;

    protected override void OnMouseMove(MouseEventArgs e)
    {
        int h = HitTest(e.Location);
        if (h != _hover) { _hover = h; Invalidate(); }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        if (_hover != -1 || _pressed != -1) { _hover = -1; _pressed = -1; Invalidate(); }
        base.OnMouseLeave(e);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { _pressed = HitTest(e.Location); Invalidate(); }
        base.OnMouseDown(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left)
        {
            int h = HitTest(e.Location);
            if (h == _pressed && h >= 0)
            {
                if (h == 0) MinClick?.Invoke(this, EventArgs.Empty);
                else if (h == 1) MaxClick?.Invoke(this, EventArgs.Empty);
                else CloseClick?.Invoke(this, EventArgs.Empty);
            }
            _pressed = -1;
            Invalidate();
        }
        base.OnMouseUp(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        for (int i = 0; i < 3; i++)
        {
            var r = BtnRect(i);
            bool isClose = i == 2;
            Color glyph = MacTheme.Ink;

            // 悬停 / 按下底色：关闭键用 Windows 红，其余用半透明灰
            if (_pressed == i && _hover == i)
            {
                using var b = new SolidBrush(isClose ? Color.FromArgb(196, 43, 28) : MacTheme.SelPill);
                g.FillRectangle(b, r);
                if (isClose) glyph = Color.White;
            }
            else if (_hover == i)
            {
                using var b = new SolidBrush(isClose ? Color.FromArgb(232, 17, 35) : MacTheme.HoverPill);
                g.FillRectangle(b, r);
                if (isClose) glyph = Color.White;
            }

            // 图标按整数像素绘制，保证锐利
            g.SmoothingMode = SmoothingMode.None;
            float cx = r.X + r.Width / 2f, cy = r.Y + r.Height / 2f;
            using var pen = new Pen(glyph, 1f);
            switch (i)
            {
                case 0: // 最小化
                    g.DrawLine(pen, (int)(cx - 5), (int)cy, (int)(cx + 5) + 1, (int)cy);
                    break;
                case 1: // 最大化（空心方框）/ 还原（双框）
                    if (_maximized)
                    {
                        g.DrawLine(pen, (int)(cx - 2), (int)(cy - 5), (int)(cx + 4), (int)(cy - 5));
                        g.DrawLine(pen, (int)(cx + 4), (int)(cy - 5), (int)(cx + 4), (int)(cy + 1));
                        g.DrawRectangle(pen, (int)(cx - 5), (int)(cy - 2), 7, 7);
                    }
                    else
                        g.DrawRectangle(pen, (int)(cx - 4.5f), (int)(cy - 4.5f), 9, 9);
                    break;
                case 2: // 关闭（X）
                    g.DrawLine(pen, (int)(cx - 5), (int)(cy - 5), (int)(cx + 5) + 1, (int)(cy + 5) + 1);
                    g.DrawLine(pen, (int)(cx + 5), (int)(cy - 5), (int)(cx - 5) - 1, (int)(cy + 5) + 1);
                    break;
            }
        }
    }
}

// ==================== macOS 圆角按钮 ====================
public enum MacBtnKind { Normal, Primary, Destructive, DangerFill }

public class MacButton : Button
{
    public MacBtnKind Kind { get; set; } = MacBtnKind.Normal;
    public float Radius { get; set; } = 7f;
    private bool _hover, _press;

    public MacButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Cursor = Cursors.Hand;
        Font = MacTheme.F(9.5f);
        Size = new Size(96, 30);
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; _press = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _press = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _press = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        var rect = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);

        Color fill, text;
        bool bordered = false;

        switch (Kind)
        {
            case MacBtnKind.Primary:
                fill = _press ? MacTheme.AccentDown : MacTheme.Accent;
                text = Color.White;
                break;
            case MacBtnKind.DangerFill:
                fill = _press ? MacTheme.DangerDown : MacTheme.Danger;
                text = Color.White;
                break;
            case MacBtnKind.Destructive:
                fill = _press ? MacTheme.TrackFill : (_hover ? MacTheme.HoverPill : MacTheme.CardFace);
                text = MacTheme.Danger;
                bordered = true;
                break;
            default:
                fill = _press ? MacTheme.TrackFill : (_hover ? MacTheme.HoverPill : MacTheme.CardFace);
                text = MacTheme.Ink;
                bordered = true;
                break;
        }

        if (!Enabled)
        {
            fill = MacTheme.Alpha(fill, 90);
            text = MacTheme.Alpha(text, 110);
        }

        using (var b = new SolidBrush(fill))
            Gfx.FillRounded(g, b, rect, Radius);

        if (bordered && !MacTheme.IsDark)
        {
            using var p = new Pen(MacTheme.Hairline, 1f);
            Gfx.DrawRounded(g, p, rect, Radius);
        }

        TextRenderer.DrawText(g, Text, Font,
            new Rectangle(0, 0, Width, Height), text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

// ==================== macOS 滑动开关 ====================
public class MacToggle : Control
{
    private bool _checked;
    public event EventHandler? CheckedChanged;

    public bool Checked
    {
        get => _checked;
        set { if (_checked != value) { _checked = value; Invalidate(); CheckedChanged?.Invoke(this, EventArgs.Empty); } }
    }

    public MacToggle()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Size = new Size(44, 26);
        Cursor = Cursors.Hand;
    }

    protected override void OnClick(EventArgs e)
    {
        Checked = !Checked;
        base.OnClick(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        var track = new RectangleF(1, 1, Width - 2, Height - 2);
        Color trackColor = Checked ? MacTheme.Success
            : (MacTheme.IsDark ? Color.FromArgb(70, 70, 74) : Color.FromArgb(233, 233, 236));
        using (var tb = new SolidBrush(trackColor))
            Gfx.FillRounded(g, tb, track, track.Height / 2);

        float d = Height - 6;
        float kx = Checked ? Width - d - 3 : 3;
        // 旋钮阴影 + 旋钮
        using (var sb = new SolidBrush(Color.FromArgb(50, 0, 0, 0)))
            g.FillEllipse(sb, kx, 4, d, d);
        using (var kb = new SolidBrush(Color.White))
            g.FillEllipse(kb, kx, 3, d, d);
    }
}

// ==================== macOS 分段选择器 ====================
public class MacSegmented : Control
{
    private string[] _items = Array.Empty<string>();
    private int _selected;
    private int _hover = -1;
    public event EventHandler? SelectedIndexChanged;

    public string[] Items
    {
        get => _items;
        set { _items = value ?? Array.Empty<string>(); _selected = 0; Invalidate(); }
    }

    public int SelectedIndex
    {
        get => _selected;
        set
        {
            int v = Math.Clamp(value, 0, Math.Max(0, _items.Length - 1));
            if (_selected != v) { _selected = v; Invalidate(); SelectedIndexChanged?.Invoke(this, EventArgs.Empty); }
        }
    }

    public MacSegmented()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Size = new Size(320, 30);
        Font = MacTheme.F(9.5f);
        Cursor = Cursors.Hand;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        int h = _items.Length == 0 ? -1 : Math.Min(_items.Length - 1, e.X * _items.Length / Math.Max(1, Width));
        if (h != _hover) { _hover = h; Invalidate(); }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e) { _hover = -1; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        if (_items.Length > 0)
            SelectedIndex = Math.Min(_items.Length - 1, e.X * _items.Length / Math.Max(1, Width));
        base.OnMouseClick(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        if (_items.Length == 0) return;

        var track = new RectangleF(0, 0, Width - 1, Height - 1);
        using (var tb = new SolidBrush(MacTheme.TrackFill))
            Gfx.FillRounded(g, tb, track, 7);

        float segW = (float)(Width - 4) / _items.Length;

        // 选中药丸
        var sel = new RectangleF(2 + _selected * segW + 1, 2.5f, segW - 2, Height - 5.5f);
        using (var sh = new SolidBrush(Color.FromArgb(MacTheme.IsDark ? 60 : 45, 0, 0, 0)))
            Gfx.FillRounded(g, sh, new RectangleF(sel.X, sel.Y + 1, sel.Width, sel.Height), 5.5f);
        using (var pb = new SolidBrush(MacTheme.IsDark ? Color.FromArgb(99, 99, 103) : Color.White))
            Gfx.FillRounded(g, pb, sel, 5.5f);

        for (int i = 0; i < _items.Length; i++)
        {
            var r = new Rectangle((int)(2 + i * segW), 0, (int)segW, Height);
            Color c = i == _selected ? MacTheme.Ink : (i == _hover ? MacTheme.Ink : MacTheme.Ink2);
            using var f = MacTheme.F(9f, i == _selected ? FontStyle.Bold : FontStyle.Regular);
            TextRenderer.DrawText(g, _items[i], f, r, c,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }
}

// ==================== macOS 圆角输入框 ====================
public class MacTextBox : UserControl
{
    public TextBox Inner { get; }
    private bool _focused;

    public string TextValue
    {
        get => Inner.Text;
        set => Inner.Text = value;
    }

    public event EventHandler? ValueChanged;

    public MacTextBox()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Color.Transparent;

        Inner = new TextBox
        {
            BorderStyle = BorderStyle.None,
            Font = MacTheme.F(10f),
            AutoSize = false,
            Height = 22
        };
        Inner.GotFocus += (s, e) => { _focused = true; Invalidate(); };
        Inner.LostFocus += (s, e) => { _focused = false; Invalidate(); };
        Inner.TextChanged += (s, e) => ValueChanged?.Invoke(this, e);
        Controls.Add(Inner);
        ApplyTheme();
        Height = 32; // 触发 OnResize -> LayoutInner，须放在 Inner 创建之后
    }

    public void ApplyTheme()
    {
        Inner.BackColor = MacTheme.CardFace;
        Inner.ForeColor = MacTheme.Ink;
        Invalidate();
    }

    private void LayoutInner()
    {
        if (Inner is null) return;
        Inner.Location = new Point(11, (Height - Inner.Height) / 2);
        Inner.Width = Width - 22;
    }

    protected override void OnResize(EventArgs e) { LayoutInner(); base.OnResize(e); }
    protected override void OnClick(EventArgs e) { Inner.Focus(); base.OnClick(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        var rect = new RectangleF(1.5f, 1.5f, Width - 4, Height - 4);

        using (var fb = new SolidBrush(MacTheme.CardFace))
            Gfx.FillRounded(g, fb, rect, 6);

        if (_focused)
        {
            using var ring = new Pen(MacTheme.FocusRing, 3f);
            var rr = rect; rr.Inflate(1.5f, 1.5f);
            Gfx.DrawRounded(g, ring, rr, 8);
            using var edge = new Pen(MacTheme.Accent, 1f);
            Gfx.DrawRounded(g, edge, rect, 6);
        }
        else
        {
            using var edge = new Pen(MacTheme.IsDark ? MacTheme.Hairline : Color.FromArgb(60, 0, 0, 0), 1f);
            Gfx.DrawRounded(g, edge, rect, 6);
        }
    }
}

// ==================== macOS 卡片（柔和投影） ====================
public class MacCard : Panel
{
    public float Radius { get; set; } = 11f;

    public MacCard()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = MacTheme.WindowBg;
    }

    public RectangleF FaceRect => new(2, 1, Width - 5, Height - 5);

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        using (var bg = new SolidBrush(MacTheme.WindowBg))
            g.FillRectangle(bg, ClientRectangle);
        var face = FaceRect;
        using (var fb = new SolidBrush(MacTheme.CardFace))
            Gfx.FillRounded(g, fb, face, Radius);
        if (!MacTheme.IsDark)
        {
            using var edge = new Pen(Color.FromArgb(18, 0, 0, 0), 1f);
            Gfx.DrawRounded(g, edge, face, Radius);
        }
    }
}

// ==================== macOS 进度条 ====================
public class MacProgressBar : Control
{
    private int _value;
    private bool _indeterminate;
    private float _slide;
    private bool _forward = true;
    private readonly Timer _timer;

    public int Value { get => _value; set { _value = Math.Clamp(value, 0, 100); Invalidate(); } }

    public bool Indeterminate
    {
        get => _indeterminate;
        set { _indeterminate = value; _timer.Enabled = value; Invalidate(); }
    }

    public MacProgressBar()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Height = 6;
        _timer = new Timer { Interval = 33 };
        _timer.Tick += (s, e) =>
        {
            _slide += _forward ? 0.035f : -0.035f;
            if (_slide > 0.65f) _forward = false;
            if (_slide < 0) _forward = true;
            Invalidate();
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _timer.Dispose();
        base.Dispose(disposing);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        var track = new RectangleF(0, 0, Width - 1, Height - 1);
        using (var tb = new SolidBrush(MacTheme.TrackFill))
            Gfx.FillRounded(g, tb, track, track.Height / 2);

        using var ab = new SolidBrush(MacTheme.Accent);
        if (Indeterminate)
        {
            float w = Width * 0.35f;
            float x = _slide * Width;
            Gfx.FillRounded(g, ab, new RectangleF(x, 0, w, Height - 1), (Height - 1) / 2);
        }
        else if (Value > 0)
        {
            float w = Math.Max(Height, Width * Value / 100f);
            Gfx.FillRounded(g, ab, new RectangleF(0, 0, w, Height - 1), (Height - 1) / 2);
        }
    }
}

// ==================== macOS 侧栏导航项 ====================
public class MacNavItem : Control
{
    public string IconName { get; set; } = "doc";
    public string Label { get; set; } = "";
    private bool _selected;
    private bool _hover;

    public bool Selected
    {
        get => _selected;
        set { _selected = value; Invalidate(); }
    }

    public MacNavItem()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                 ControlStyles.SupportsTransparentBackColor, true);
        Size = new Size(196, 30);
        BackColor = Color.Transparent;
        Cursor = Cursors.Hand;
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);

        if (Selected || _hover)
        {
            using var pb = new SolidBrush(Selected ? MacTheme.SelPill : MacTheme.HoverPill);
            Gfx.FillRounded(g, pb, new RectangleF(4, 1, Width - 9, Height - 2), 6);
        }

        var iconRect = new RectangleF(14, (Height - 16) / 2f, 16, 16);
        MacIcons.Draw(g, IconName, iconRect, Selected ? MacTheme.Accent : MacTheme.Ink2, 1.5f);

        using var f = MacTheme.F(9.5f, Selected ? FontStyle.Bold : FontStyle.Regular);
        TextRenderer.DrawText(g, Label, f,
            new Rectangle(40, 0, Width - 48, Height),
            Selected ? MacTheme.Ink : MacTheme.Ink,
            TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

// ==================== macOS 图标控件 ====================
public class MacIconView : Control
{
    public string IconName { get; set; } = "doc";
    public Color? IconColor { get; set; }
    public float Stroke { get; set; } = 1.6f;
    public Color? Knockout { get; set; }

    public MacIconView()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                 ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        Size = new Size(18, 18);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        MacIcons.Draw(e.Graphics, IconName, ClientRectangle, IconColor ?? MacTheme.Ink2, Stroke, Knockout);
    }
}

// ==================== macOS 风格对话框 ====================
public class MacAlert : Form
{
    private bool _ok;

    private MacAlert(string title, string message, string okText, string? cancelText, bool destructive)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterParent;
        BackColor = MacTheme.WindowBg;
        Width = 420;
        Font = MacTheme.F(9.5f);
        DoubleBuffered = true;
        ShowInTaskbar = false;

        int msgH = TextRenderer.MeasureText(message, MacTheme.F(9.5f), new Size(370, 1000),
            TextFormatFlags.WordBreak).Height;
        Height = 96 + msgH + 56;

        var lblTitle = new Label
        {
            Text = title,
            Font = MacTheme.F(13f, FontStyle.Bold),
            ForeColor = MacTheme.Ink,
            BackColor = Color.Transparent,
            Location = new Point(22, 18),
            Size = new Size(376, 24)
        };
        Controls.Add(lblTitle);

        var lblMsg = new Label
        {
            Text = message,
            Font = MacTheme.F(9.5f),
            ForeColor = MacTheme.Ink2,
            BackColor = Color.Transparent,
            Location = new Point(22, 50),
            Size = new Size(376, msgH + 8)
        };
        Controls.Add(lblMsg);

        var btnOk = new MacButton
        {
            Text = okText,
            Kind = destructive ? MacBtnKind.DangerFill : MacBtnKind.Primary,
            Size = new Size(96, 30),
            Location = new Point(Width - 22 - 96, Height - 44)
        };
        btnOk.Click += (s, e) => { _ok = true; Close(); };
        Controls.Add(btnOk);

        if (cancelText != null)
        {
            var btnCancel = new MacButton
            {
                Text = cancelText,
                Kind = MacBtnKind.Normal,
                Size = new Size(88, 30),
                Location = new Point(Width - 22 - 96 - 10 - 88, Height - 44)
            };
            btnCancel.Click += (s, e) => { _ok = false; Close(); };
            Controls.Add(btnCancel);
        }

        KeyPreview = true;
        KeyDown += (s, e) =>
        {
            if (e.KeyCode == Keys.Escape) { _ok = false; Close(); }
            if (e.KeyCode == Keys.Enter) { _ok = true; Close(); }
        };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        DwmHelper.EnableRoundedCorners(Handle);
        DwmHelper.EnableShadow(Handle);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var edge = new Pen(MacTheme.Hairline, 1f);
        e.Graphics.DrawRectangle(edge, 0, 0, Width - 1, Height - 1);
    }

    // 拖拽移动
    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == 0x84 && m.Result == (IntPtr)1)
            m.Result = (IntPtr)2; // HTCAPTION
    }

    public static bool Confirm(IWin32Window owner, string title, string message,
        string okText = "好", string? cancelText = "取消", bool destructive = false)
    {
        using var dlg = new MacAlert(title, message, okText, cancelText, destructive);
        dlg.ShowDialog(owner);
        return dlg._ok;
    }

    public static void Info(IWin32Window owner, string title, string message)
    {
        using var dlg = new MacAlert(title, message, "好", null, false);
        dlg.ShowDialog(owner);
    }
}
