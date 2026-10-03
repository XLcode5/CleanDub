using System;
using System.Drawing;
using System.Windows.Forms;

namespace CleanDub.Gui;

public enum ToastKind { Success, Info, Error }

/// <summary>
/// 轻量 Toast 提示：窗口底部居中的深色胶囊，2 秒后淡出自动消失。
/// 通过 Region 裁剪实现真圆角，不依赖窗口透明。
/// </summary>
public class Toast : Control
{
    private const int HoldMs = 2000;
    private const int FadeMs = 260;

    private readonly string _message;
    private readonly ToastKind _kind;
    private readonly Timer _timer;
    private readonly Control _host;
    private int _elapsed;
    private float _fade; // 0 = 完全不透明, 1 = 完全消失

    private Toast(Control host, string message, ToastKind kind)
    {
        _host = host;
        _message = message;
        _kind = kind;

        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = host.BackColor;

        using (var f = MacTheme.F(9f))
        {
            var size = TextRenderer.MeasureText(message, f);
            Size = new Size(Math.Min(size.Width + 62, host.Width - 80), 34);
        }
        PositionSelf();

        // 用 Region 裁出胶囊形状（真圆角，无直角残影）
        using (var path = Gfx.RoundedRect(new RectangleF(0, 0, Width, Height), Height / 2f))
            Region = new Region(path);

        _timer = new Timer { Interval = 30 };
        _timer.Tick += (s, e) =>
        {
            _elapsed += _timer.Interval;
            if (_elapsed < HoldMs) return;
            _fade = Math.Min(1f, (_elapsed - HoldMs) / (float)FadeMs);
            Invalidate();
            if (_fade >= 1f) Dispose();
        };

        host.Resize += HostResize;
        Disposed += (s, e) => { _timer.Stop(); _timer.Dispose(); host.Resize -= HostResize; };
    }

    private void HostResize(object? s, EventArgs e) => PositionSelf();

    private void PositionSelf()
    {
        Left = (_host.ClientSize.Width - Width) / 2;
        Top = _host.ClientSize.Height - Height - 30;
    }

    /// <summary>在指定容器（通常是主窗口内容区）底部弹出提示。</summary>
    public static void Show(Control host, string message, ToastKind kind = ToastKind.Success)
    {
        var toast = new Toast(host, message, kind);
        host.Controls.Add(toast);
        toast.BringToFront();
        toast._timer.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);

        // macOS 风格深色胶囊，深浅主题下都用深色底 + 白字
        int a = (int)(242 * (1f - _fade));
        var tint = _kind switch
        {
            ToastKind.Success => Color.FromArgb(48, 209, 88),
            ToastKind.Error => Color.FromArgb(255, 69, 58),
            _ => Color.FromArgb(64, 156, 255)
        };
        var icon = _kind switch
        {
            ToastKind.Success => "check",
            ToastKind.Error => "xmark",
            _ => "info"
        };

        using (var bg = new SolidBrush(Color.FromArgb(a, 38, 38, 42)))
            g.FillRectangle(bg, ClientRectangle);

        // 图标圆点
        var dot = new RectangleF(12, Height / 2f - 8, 16, 16);
        using (var db = new SolidBrush(Color.FromArgb(a, tint)))
            g.FillEllipse(db, dot);
        MacIcons.Draw(g, icon, new RectangleF(dot.X + 3.5f, dot.Y + 3.5f, 9, 9),
            Color.FromArgb(a, Color.White), 1.4f);

        using var f = MacTheme.F(9f);
        TextRenderer.DrawText(g, _message, f,
            new Rectangle(36, 0, Width - 44, Height), Color.FromArgb(a, 245, 245, 247),
            TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}
