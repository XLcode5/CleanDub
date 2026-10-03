using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CleanDub.Gui;

/// <summary>历史页自绘列表：图标块 + 操作名 + 相对时间 + 详情。</summary>
public class HistoryList : Control
{
    private const int RowH = 52;
    private readonly List<HistoryItem> _items = new();
    private int _scroll;
    private int _hover = -1;
    private readonly VScrollBar _bar;

    public event EventHandler<HistoryItem>? ItemDoubleClick;

    public HistoryList()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = MacTheme.WindowBg;
        _bar = new VScrollBar { Dock = DockStyle.Right, Width = 12, Visible = false };
        _bar.Scroll += (s, e) => { _scroll = _bar.Value; Invalidate(); };
        Controls.Add(_bar);
    }

    public void SetItems(IEnumerable<HistoryItem> items)
    {
        _items.Clear();
        _items.AddRange(items);
        _scroll = 0;
        UpdateScroll();
        Invalidate();
    }

    public void RefreshTheme() => Invalidate();

    private void UpdateScroll()
    {
        int total = _items.Count * RowH;
        _bar.Visible = total > Height;
        if (_bar.Visible)
        {
            _bar.Minimum = 0;
            _bar.Maximum = Math.Max(0, total - Height + RowH);
            _bar.LargeChange = Height;
            _bar.SmallChange = RowH;
            _scroll = Math.Min(_scroll, _bar.Maximum);
        }
        else _scroll = 0;
    }

    protected override void OnResize(EventArgs e) { UpdateScroll(); base.OnResize(e); }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        if (_bar.Visible)
        {
            _scroll = Math.Clamp(_scroll - Math.Sign(e.Delta) * RowH, 0, _bar.Maximum);
            _bar.Value = _scroll;
            Invalidate();
        }
        base.OnMouseWheel(e);
    }

    private int HitIndex(int y)
    {
        int idx = (y + _scroll) / RowH;
        return idx >= 0 && idx < _items.Count ? idx : -1;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        int idx = HitIndex(e.Y);
        if (idx != _hover) { _hover = idx; Invalidate(); }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e) { _hover = -1; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseDoubleClick(MouseEventArgs e)
    {
        int idx = HitIndex(e.Y);
        if (idx >= 0) ItemDoubleClick?.Invoke(this, _items[idx]);
        base.OnMouseDoubleClick(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Gfx.Smooth(g);
        int w = Width - (_bar.Visible ? _bar.Width : 0);

        using var nameF = MacTheme.F(9.5f);
        using var subF = MacTheme.F(8f);
        using var timeF = MacTheme.F(8f);

        int first = Math.Max(0, _scroll / RowH - 1);
        int last = Math.Min(_items.Count - 1, (_scroll + Height) / RowH + 1);

        for (int i = first; i <= last; i++)
        {
            var item = _items[i];
            int y = i * RowH - _scroll;

            if (i == _hover)
            {
                using var hv = new SolidBrush(MacTheme.HoverPill);
                g.FillRectangle(hv, 0, y, w, RowH);
            }

            // 类型图标块
            var (icon, tint) = item.Op switch
            {
                "scan" => ("search", MacTheme.Accent),
                "quarantine" => ("box", MacTheme.Warning),
                "restore" => ("refresh", MacTheme.Success),
                "purge" => ("trash", MacTheme.Danger),
                "delete" => ("trash", MacTheme.Danger),
                _ => ("doc", MacTheme.Ink3)
            };
            var tile = new RectangleF(14, y + RowH / 2f - 15, 30, 30);
            using (var tb = new SolidBrush(MacTheme.Alpha(tint, MacTheme.IsDark ? 46 : 22)))
                Gfx.FillRounded(g, tb, tile, 8);
            MacIcons.Draw(g, icon, new RectangleF(tile.X + 7, tile.Y + 7, 16, 16), tint, 1.6f);

            // 第一行：操作名 + 相对时间
            TextRenderer.DrawText(g, item.OpLabel, nameF,
                new Rectangle(56, y + 8, 200, 18), MacTheme.Ink, TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(g, item.RelativeTime, timeF,
                new Rectangle(w - 170, y + 9, 150, 16), MacTheme.Ink3,
                TextFormatFlags.Right | TextFormatFlags.EndEllipsis);

            // 第二行：详情 + 大小
            string detail = item.Detail;
            if (item.Bytes > 0 && !detail.Contains(item.BytesLabel))
                detail += (detail.Length > 0 ? " · " : "") + item.BytesLabel;
            TextRenderer.DrawText(g, detail, subF,
                new Rectangle(56, y + 27, w - 76, 16), MacTheme.Ink2, TextFormatFlags.EndEllipsis);

            using var sep = new Pen(MacTheme.Separator, 1f);
            g.DrawLine(sep, 56, y + RowH - 1, w - 12, y + RowH - 1);
        }
    }
}

/// <summary>隔离区自绘列表：会话头（可折叠 + 整组勾选）+ 文件行（复选框）。</summary>
public class QuarantineList : Control
{
    private const int HeaderH = 42;
    private const int RowH = 34;
    private readonly List<QuarantineSession> _sessions = new();
    private int _scroll;
    private int _hover = -1;          // 行索引（扁平化后）
    private readonly VScrollBar _bar;

    // 扁平化行：会话头或文件行
    private readonly List<object> _rows = new();

    public event EventHandler? SelectionChanged;

    public QuarantineList()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = MacTheme.WindowBg;
        _bar = new VScrollBar { Dock = DockStyle.Right, Width = 12, Visible = false };
        _bar.Scroll += (s, e) => { _scroll = _bar.Value; Invalidate(); };
        Controls.Add(_bar);
    }

    public int SelectedCount { get; private set; }
    public long SelectedBytes { get; private set; }

    public void SetSessions(IEnumerable<QuarantineSession> sessions)
    {
        _sessions.Clear();
        _sessions.AddRange(sessions);
        RebuildRows();
    }

    /// <summary>当前所有勾选的 (session, entry) 对。</summary>
    public List<(QuarantineSession Session, QuarantineEntry Entry)> SelectedEntries() =>
        _sessions.SelectMany(s => s.Files.Where(f => f.Selected).Select(f => (s, f))).ToList();

    public void RefreshTheme() => Invalidate();

    private void RebuildRows()
    {
        _rows.Clear();
        foreach (var s in _sessions)
        {
            _rows.Add(s);
            if (s.Expanded)
                foreach (var f in s.Files) _rows.Add((s, f));
        }
        RecountSelection();
        _scroll = 0;
        UpdateScroll();
        Invalidate();
    }

    private void RecountSelection()
    {
        SelectedCount = _sessions.Sum(s => s.Files.Count(f => f.Selected));
        SelectedBytes = _sessions.Sum(s => s.Files.Where(f => f.Selected).Sum(f => f.Size));
    }

    private int TotalHeight() => _rows.Sum(r => r is QuarantineSession ? HeaderH : RowH);

    private void UpdateScroll()
    {
        int total = TotalHeight();
        _bar.Visible = total > Height;
        if (_bar.Visible)
        {
            _bar.Minimum = 0;
            _bar.Maximum = Math.Max(0, total - Height + RowH);
            _bar.LargeChange = Height;
            _bar.SmallChange = RowH;
            _scroll = Math.Min(_scroll, _bar.Maximum);
        }
        else _scroll = 0;
    }

    protected override void OnResize(EventArgs e) { UpdateScroll(); base.OnResize(e); }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        if (_bar.Visible)
        {
            _scroll = Math.Clamp(_scroll - Math.Sign(e.Delta) * RowH, 0, _bar.Maximum);
            _bar.Value = _scroll;
            Invalidate();
        }
        base.OnMouseWheel(e);
    }

    /// <summary>命中测试：返回行索引与该行的 Y 偏移。</summary>
    private int HitRow(int y, out int rowTop)
    {
        int acc = -_scroll;
        for (int i = 0; i < _rows.Count; i++)
        {
            int h = _rows[i] is QuarantineSession ? HeaderH : RowH;
            if (y >= acc && y < acc + h) { rowTop = acc; return i; }
            acc += h;
        }
        rowTop = 0;
        return -1;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        int idx = HitRow(e.Y, out _);
        if (idx != _hover) { _hover = idx; Invalidate(); }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e) { _hover = -1; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        int idx = HitRow(e.Y, out _);
        if (idx < 0) { base.OnMouseClick(e); return; }

        if (_rows[idx] is QuarantineSession s)
        {
            if (e.X < 34) // 箭头区：折叠/展开
            {
                s.Expanded = !s.Expanded;
                RebuildRows();
            }
            else if (e.X < 60) // 复选框区：整组勾选/取消
            {
                bool target = s.Files.Any(f => !f.Selected);
                foreach (var f in s.Files) f.Selected = target;
                RecountSelection();
                Invalidate();
                SelectionChanged?.Invoke(this, EventArgs.Empty);
            }
        }
        else if (_rows[idx] is ValueTuple<QuarantineSession, QuarantineEntry> pair)
        {
            if (e.X >= 34 && e.X < 60)
            {
                pair.Item2.Selected = !pair.Item2.Selected;
                RecountSelection();
                Invalidate();
                SelectionChanged?.Invoke(this, EventArgs.Empty);
            }
        }
        base.OnMouseClick(e);
    }

    private static void DrawCheck(Graphics g, RectangleF rc, bool? state)
    {
        // state: true 全选 / false 未选 / null 半选
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
        int w = Width - (_bar.Visible ? _bar.Width : 0);

        using var nameF = MacTheme.F(9.5f);
        using var subF = MacTheme.F(8f);
        using var boldF = MacTheme.F(9.5f, FontStyle.Bold);

        int y = -_scroll;
        for (int i = 0; i < _rows.Count; i++)
        {
            if (_rows[i] is QuarantineSession s)
            {
                if (y + HeaderH >= 0 && y <= Height)
                {
                    if (i == _hover)
                    {
                        using var hv = new SolidBrush(MacTheme.HoverPill);
                        g.FillRectangle(hv, 0, y, w, HeaderH);
                    }
                    // 折叠箭头
                    using (var pen = new Pen(MacTheme.Ink3, 1.5f))
                    {
                        float cx = 22, cy = y + HeaderH / 2f;
                        if (s.Expanded)
                            g.DrawLines(pen, new[] { new PointF(cx - 4, cy - 2), new PointF(cx, cy + 2), new PointF(cx + 4, cy - 2) });
                        else
                            g.DrawLines(pen, new[] { new PointF(cx - 2, cy - 4), new PointF(cx + 2, cy), new PointF(cx - 2, cy + 4) });
                    }
                    // 组复选框（三态）
                    bool? state = s.SelectedCount == 0 ? false :
                                  s.SelectedCount == s.Files.Count ? true : null;
                    DrawCheck(g, new RectangleF(40, y + HeaderH / 2f - 8, 16, 16), state);

                    TextRenderer.DrawText(g, s.CreatedLabel, boldF,
                        new Rectangle(66, y + 7, 200, 16), MacTheme.Ink, TextFormatFlags.EndEllipsis);
                    TextRenderer.DrawText(g, $"{s.Files.Count} 个文件 · {s.TotalLabel}", subF,
                        new Rectangle(66, y + 23, 220, 14), MacTheme.Ink2, TextFormatFlags.EndEllipsis);

                    using var sep = new Pen(MacTheme.Separator, 1f);
                    g.DrawLine(sep, 66, y + HeaderH - 1, w - 12, y + HeaderH - 1);
                }
                y += HeaderH;
            }
            else if (_rows[i] is ValueTuple<QuarantineSession, QuarantineEntry> pair)
            {
                var entry = pair.Item2;
                if (y + RowH >= 0 && y <= Height)
                {
                    if (i == _hover)
                    {
                        using var hv = new SolidBrush(MacTheme.HoverPill);
                        g.FillRectangle(hv, 34, y, w - 34, RowH);
                    }
                    DrawCheck(g, new RectangleF(40, y + RowH / 2f - 8, 16, 16), entry.Selected);
                    MacIcons.Draw(g, "doc", new RectangleF(66, y + RowH / 2f - 7, 14, 14), MacTheme.Ink3, 1.4f);

                    int pathX = 90;
                    int sizeW = 90;
                    TextRenderer.DrawText(g, entry.Original, nameF,
                        new Rectangle(pathX, y, w - pathX - sizeW - 20, RowH), MacTheme.Ink,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.PathEllipsis);
                    TextRenderer.DrawText(g, entry.SizeLabel, subF,
                        new Rectangle(w - sizeW - 12, y, sizeW, RowH), MacTheme.Ink2,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.Right);
                }
                y += RowH;
            }
        }
    }
}
