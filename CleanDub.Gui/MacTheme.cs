using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace CleanDub.Gui;

/// <summary>CleanDub 主题：Knowledge Base 配色 / 字体</summary>
public static class MacTheme
{
    public static bool IsDark { get; set; }

    // ==================== Palette (Knowledge Base) ====================
    // 浅色模式
    public static Color WindowBg   => IsDark ? Color.FromArgb(13, 17, 23)      : Color.FromArgb(248, 250, 252);
    public static Color SidebarBg  => IsDark ? Color.FromArgb(22, 27, 34)      : Color.FromArgb(234, 239, 243);
    public static Color CardFace   => IsDark ? Color.FromArgb(22, 27, 34)      : Color.White;
    public static Color CardHover  => IsDark ? Color.FromArgb(36, 41, 49)      : Color.FromArgb(250, 250, 252);
    public static Color Ink        => IsDark ? Color.FromArgb(230, 237, 243)   : Color.FromArgb(30, 41, 59);
    public static Color Ink2       => IsDark ? Color.FromArgb(139, 148, 158)   : Color.FromArgb(71, 85, 105);
    public static Color Ink3       => IsDark ? Color.FromArgb(110, 118, 129)   : Color.FromArgb(100, 116, 139);

    public static Color Accent     => IsDark ? Color.FromArgb(88, 166, 255)    : Color.FromArgb(37, 99, 235);
    public static Color AccentDown => IsDark ? Color.FromArgb(56, 139, 253)    : Color.FromArgb(29, 78, 216);
    public static Color Danger     => IsDark ? Color.FromArgb(248, 81, 73)     : Color.FromArgb(220, 38, 38);
    public static Color DangerDown => IsDark ? Color.FromArgb(218, 54, 51)     : Color.FromArgb(185, 28, 28);
    public static Color Success    => IsDark ? Color.FromArgb(63, 185, 80)     : Color.FromArgb(22, 163, 74);
    public static Color Warning    => Color.FromArgb(217, 119, 6);
    public static Color Purple     => IsDark ? Color.FromArgb(191, 90, 242)    : Color.FromArgb(175, 82, 222);

    public static Color Separator  => IsDark ? Color.FromArgb(48, 54, 61)      : Color.FromArgb(226, 232, 240);
    public static Color Hairline   => IsDark ? Color.FromArgb(48, 54, 61)      : Color.FromArgb(226, 232, 240);
    public static Color SelPill    => IsDark ? Color.FromArgb(56, 139, 253, 40) : Color.FromArgb(37, 99, 235, 20);
    public static Color HoverPill  => IsDark ? Color.FromArgb(177, 186, 196, 12) : Color.FromArgb(31, 35, 40, 8);
    public static Color TrackFill  => IsDark ? Color.FromArgb(48, 54, 61)      : Color.FromArgb(234, 239, 243);
    public static Color RowSel     => IsDark ? Color.FromArgb(56, 139, 253, 30) : Color.FromArgb(37, 99, 235, 15);
    public static Color FocusRing  => IsDark ? Color.FromArgb(88, 166, 255, 60) : Color.FromArgb(37, 99, 235, 50);

    // ==================== Fonts ====================
    private static FontFamily? _ui;
    public static FontFamily Ui
    {
        get
        {
            if (_ui == null)
            {
                foreach (var f in FontFamily.Families)
                    if (f.Name == "Segoe UI Variable Text") { _ui = f; break; }
                _ui ??= new FontFamily("Segoe UI");
            }
            return _ui;
        }
    }

    public static Font F(float size, FontStyle style = FontStyle.Regular) => new(Ui, size, style);

    public static Color Alpha(Color c, int a) => Color.FromArgb(a, c);
}

/// <summary>DWM 集成：圆角窗口 / 阴影 / 深色标题栏</summary>
public static class DwmHelper
{
    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);

    [StructLayout(LayoutKind.Sequential)]
    public struct MARGINS { public int Left, Right, Top, Bottom; }

    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;
    private const int DWMWCP_ROUND = 2;
    private const int DWMSBT_MAINWINDOW = 2; // Mica

    /// <summary>Windows 11 圆角窗口（Win10 上静默失败）</summary>
    public static void EnableRoundedCorners(IntPtr hwnd)
    {
        int pref = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int));
    }

    /// <summary>Windows 11 Mica 背景材质（22000+，不支持时静默失败）</summary>
    public static void EnableMica(IntPtr hwnd)
    {
        int backdrop = DWMSBT_MAINWINDOW;
        DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, sizeof(int));
    }

    /// <summary>为无边框窗口补回 DWM 投影</summary>
    public static void EnableShadow(IntPtr hwnd)
    {
        var m = new MARGINS { Left = 1, Right = 1, Top = 1, Bottom = 1 };
        DwmExtendFrameIntoClientArea(hwnd, ref m);
    }

    public static void SetDarkMode(IntPtr hwnd, bool dark)
    {
        int v = dark ? 1 : 0;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref v, sizeof(int));
    }
}

/// <summary>毛玻璃背景：桌面壁纸读取 + 降采样模糊（WinForms 的 Mica 风格实现）</summary>
public static class Frosted
{
    private static Bitmap? _blur;
    private static bool _loaded;

    /// <summary>模糊后的壁纸（懒加载并缓存）</summary>
    public static Bitmap? BlurredWallpaper
    {
        get
        {
            if (!_loaded) { _loaded = true; _blur = BuildBlurred(); }
            return _blur;
        }
    }

    /// <summary>壁纸更换后调用以重建缓存</summary>
    public static void Invalidate()
    {
        _blur?.Dispose();
        _blur = null;
        _loaded = false;
    }

    private static Bitmap? LoadWallpaper()
    {
        // Windows 10/11 的壁纸转码缓存（无扩展名的 JPEG/PNG）
        try
        {
            string cache = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"Microsoft\Windows\Themes\TranscodedImageCache");
            if (File.Exists(cache)) return new Bitmap(cache);
        }
        catch { }
        // 回退：SPI_GETDESKWALLPAPER 取壁纸文件路径
        try
        {
            var sb = new StringBuilder(260);
            if (SystemParametersInfo(0x0073, sb.Capacity, sb, 0))
            {
                string p = sb.ToString();
                if (p.Length > 0 && File.Exists(p)) return new Bitmap(p);
            }
        }
        catch { }
        return null;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool SystemParametersInfo(int action, int param, StringBuilder retval, int winIni);

    private static Bitmap? BuildBlurred()
    {
        using var src = LoadWallpaper();
        if (src == null) return null;
        // 重度降采样 + 高质量放大，等效柔和的高斯模糊
        int dw = Math.Max(24, src.Width / 14), dh = Math.Max(24, src.Height / 14);
        using var small = new Bitmap(dw, dh);
        using (var g = Graphics.FromImage(small))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawImage(src, 0, 0, dw, dh);
        }
        var blur = new Bitmap(Math.Max(64, src.Width / 4), Math.Max(64, src.Height / 4));
        using (var g = Graphics.FromImage(blur))
        {
            Gfx.Smooth(g);
            g.DrawImage(small, 0, 0, blur.Width, blur.Height);
        }
        return blur;
    }
}

/// <summary>GDI+ 绘制辅助</summary>
public static class Gfx
{
    public static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        if (radius <= 0.5f) { path.AddRectangle(r); return path; }
        float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void FillRounded(Graphics g, Brush brush, RectangleF r, float radius)
    {
        using var path = RoundedRect(r, radius);
        g.FillPath(brush, path);
    }

    public static void DrawRounded(Graphics g, Pen pen, RectangleF r, float radius)
    {
        using var path = RoundedRect(r, radius);
        g.DrawPath(pen, path);
    }

    public static void Smooth(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    }
}

/// <summary>SF Symbols 风格线条图标（自绘，规避 emoji 豆腐块）</summary>
public static class MacIcons
{
    public static void Draw(Graphics g, string name, RectangleF rc, Color color, float stroke = 1.7f, Color? knockout = null)
    {
        Gfx.Smooth(g);
        using var pen = new Pen(color, stroke)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round
        };
        using var brush = new SolidBrush(color);

        float X(float f) => rc.X + f * rc.Width;
        float Y(float f) => rc.Y + f * rc.Height;
        PointF Pt(float x, float y) => new(X(x), Y(y));
        RectangleF Rc(float x, float y, float w, float h) => new(X(x), Y(y), w * rc.Width, h * rc.Height);

        switch (name)
        {
            case "search":
                g.DrawEllipse(pen, Rc(0.12f, 0.12f, 0.56f, 0.56f));
                g.DrawLine(pen, Pt(0.60f, 0.60f), Pt(0.86f, 0.86f));
                break;

            case "clock":
                g.DrawEllipse(pen, Rc(0.12f, 0.12f, 0.76f, 0.76f));
                g.DrawLine(pen, Pt(0.5f, 0.5f), Pt(0.5f, 0.28f));
                g.DrawLine(pen, Pt(0.5f, 0.5f), Pt(0.68f, 0.57f));
                break;

            case "box":
                Gfx.DrawRounded(g, pen, Rc(0.07f, 0.10f, 0.86f, 0.20f), 0.06f * rc.Width);
                Gfx.DrawRounded(g, pen, Rc(0.12f, 0.30f, 0.76f, 0.56f), 0.06f * rc.Width);
                g.DrawLine(pen, Pt(0.40f, 0.44f), Pt(0.60f, 0.44f));
                break;

            case "gear":
                for (int i = 0; i < 8; i++)
                {
                    double a = i * Math.PI / 4;
                    g.DrawLine(pen,
                        X(0.5f + 0.30f * (float)Math.Cos(a)), Y(0.5f + 0.30f * (float)Math.Sin(a)),
                        X(0.5f + 0.44f * (float)Math.Cos(a)), Y(0.5f + 0.44f * (float)Math.Sin(a)));
                }
                g.DrawEllipse(pen, Rc(0.24f, 0.24f, 0.52f, 0.52f));
                g.DrawEllipse(pen, Rc(0.40f, 0.40f, 0.20f, 0.20f));
                break;

            case "folder":
                Gfx.DrawRounded(g, pen, Rc(0.10f, 0.34f, 0.80f, 0.48f), 0.07f * rc.Width);
                g.DrawLines(pen, new[] { Pt(0.16f, 0.34f), Pt(0.16f, 0.28f), Pt(0.38f, 0.28f), Pt(0.46f, 0.34f) });
                break;

            case "doc":
                g.DrawLines(pen, new[] { Pt(0.28f, 0.08f), Pt(0.58f, 0.08f), Pt(0.76f, 0.26f), Pt(0.76f, 0.92f), Pt(0.28f, 0.92f), Pt(0.28f, 0.08f) });
                g.DrawLines(pen, new[] { Pt(0.58f, 0.08f), Pt(0.58f, 0.26f), Pt(0.76f, 0.26f) });
                break;

            case "copy":
                Gfx.DrawRounded(g, pen, Rc(0.30f, 0.10f, 0.58f, 0.56f), 0.08f * rc.Width);
                var front = Rc(0.12f, 0.34f, 0.58f, 0.56f);
                using (var kb = new SolidBrush(knockout ?? MacTheme.CardFace))
                    Gfx.FillRounded(g, kb, front, 0.08f * rc.Width);
                Gfx.DrawRounded(g, pen, front, 0.08f * rc.Width);
                break;

            case "trash":
                g.DrawLine(pen, Pt(0.18f, 0.24f), Pt(0.82f, 0.24f));
                g.DrawLines(pen, new[] { Pt(0.42f, 0.24f), Pt(0.42f, 0.15f), Pt(0.58f, 0.15f), Pt(0.58f, 0.24f) });
                Gfx.DrawRounded(g, pen, Rc(0.26f, 0.24f, 0.48f, 0.62f), 0.07f * rc.Width);
                g.DrawLine(pen, Pt(0.41f, 0.36f), Pt(0.41f, 0.74f));
                g.DrawLine(pen, Pt(0.59f, 0.36f), Pt(0.59f, 0.74f));
                break;

            case "export":
                Gfx.DrawRounded(g, pen, Rc(0.12f, 0.36f, 0.76f, 0.52f), 0.10f * rc.Width);
                g.DrawLine(pen, Pt(0.5f, 0.68f), Pt(0.5f, 0.10f));
                g.DrawLines(pen, new[] { Pt(0.34f, 0.26f), Pt(0.5f, 0.10f), Pt(0.66f, 0.26f) });
                break;

            case "moon":
            {
                var path = new GraphicsPath();
                path.AddEllipse(Rc(0.16f, 0.12f, 0.64f, 0.76f));
                var exclude = new GraphicsPath();
                exclude.AddEllipse(Rc(0.38f, 0.02f, 0.64f, 0.76f));
                var oldClip = g.Clip;
                g.SetClip(exclude, CombineMode.Exclude);
                g.FillPath(brush, path);
                g.Clip = oldClip;
                path.Dispose(); exclude.Dispose(); oldClip.Dispose();
                break;
            }

            case "sun":
                g.FillEllipse(brush, Rc(0.32f, 0.32f, 0.36f, 0.36f));
                for (int i = 0; i < 8; i++)
                {
                    double a = i * Math.PI / 4 + Math.PI / 8;
                    g.DrawLine(pen,
                        X(0.5f + 0.28f * (float)Math.Cos(a)), Y(0.5f + 0.28f * (float)Math.Sin(a)),
                        X(0.5f + 0.42f * (float)Math.Cos(a)), Y(0.5f + 0.42f * (float)Math.Sin(a)));
                }
                break;

            case "shield":
            {
                var p = new GraphicsPath();
                p.StartFigure();
                p.AddLine(Pt(0.5f, 0.08f), Pt(0.84f, 0.20f));
                p.AddLine(Pt(0.84f, 0.20f), Pt(0.84f, 0.46f));
                p.AddBezier(Pt(0.84f, 0.46f), Pt(0.84f, 0.66f), Pt(0.68f, 0.79f), Pt(0.5f, 0.92f));
                p.AddBezier(Pt(0.5f, 0.92f), Pt(0.32f, 0.79f), Pt(0.16f, 0.66f), Pt(0.16f, 0.46f));
                p.AddLine(Pt(0.16f, 0.46f), Pt(0.16f, 0.20f));
                p.CloseFigure();
                g.DrawPath(pen, p);
                p.Dispose();
                g.DrawLines(pen, new[] { Pt(0.36f, 0.48f), Pt(0.47f, 0.60f), Pt(0.66f, 0.36f) });
                break;
            }

            case "chart":
                g.DrawLines(pen, new[] { Pt(0.14f, 0.14f), Pt(0.14f, 0.84f), Pt(0.88f, 0.84f) });
                Gfx.FillRounded(g, brush, Rc(0.26f, 0.52f, 0.13f, 0.32f), 0.03f * rc.Width);
                Gfx.FillRounded(g, brush, Rc(0.46f, 0.32f, 0.13f, 0.52f), 0.03f * rc.Width);
                Gfx.FillRounded(g, brush, Rc(0.66f, 0.44f, 0.13f, 0.40f), 0.03f * rc.Width);
                break;

            case "play":
                g.FillPolygon(brush, new[] { Pt(0.32f, 0.20f), Pt(0.32f, 0.80f), Pt(0.78f, 0.50f) });
                break;

            case "stop":
                Gfx.FillRounded(g, brush, Rc(0.26f, 0.26f, 0.48f, 0.48f), 0.06f * rc.Width);
                break;

            case "xmark":
                g.DrawLine(pen, Pt(0.26f, 0.26f), Pt(0.74f, 0.74f));
                g.DrawLine(pen, Pt(0.74f, 0.26f), Pt(0.26f, 0.74f));
                break;

            case "minus":
                g.DrawLine(pen, Pt(0.24f, 0.5f), Pt(0.76f, 0.5f));
                break;

            case "plus":
                g.DrawLine(pen, Pt(0.24f, 0.5f), Pt(0.76f, 0.5f));
                g.DrawLine(pen, Pt(0.5f, 0.24f), Pt(0.5f, 0.76f));
                break;

            case "check":
                g.DrawLines(pen, new[] { Pt(0.18f, 0.52f), Pt(0.42f, 0.74f), Pt(0.82f, 0.28f) });
                break;

            case "refresh":
            {
                g.DrawArc(pen, Rc(0.16f, 0.16f, 0.68f, 0.68f), 40, 300);
                // 箭头头部（终点约 340°）
                g.DrawLines(pen, new[] { Pt(0.70f, 0.10f), Pt(0.86f, 0.28f), Pt(0.64f, 0.34f) });
                break;
            }

            case "info":
                g.DrawEllipse(pen, Rc(0.12f, 0.12f, 0.76f, 0.76f));
                g.FillEllipse(brush, Rc(0.45f, 0.26f, 0.10f, 0.10f));
                g.DrawLine(pen, Pt(0.5f, 0.46f), Pt(0.5f, 0.72f));
                break;

            case "external":
                Gfx.DrawRounded(g, pen, Rc(0.12f, 0.30f, 0.62f, 0.58f), 0.10f * rc.Width);
                g.DrawLine(pen, Pt(0.42f, 0.60f), Pt(0.84f, 0.18f));
                g.DrawLines(pen, new[] { Pt(0.60f, 0.18f), Pt(0.84f, 0.18f), Pt(0.84f, 0.42f) });
                break;
        }
    }
}
