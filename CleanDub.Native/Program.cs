using System;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

namespace CleanDub.Native;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
    }
}

public class MainForm : Form
{
    private WebView2 webView;

    public MainForm()
    {
        Text = "CleanDub - 重复文件清理";
        Width = 1100;
        Height = 750;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new System.Drawing.Size(900, 600);

        webView = new WebView2();
        webView.Dock = DockStyle.Fill;
        Controls.Add(webView);

        InitializeWebView();
    }

    private async void InitializeWebView()
    {
        try
        {
            var userDataFolder = Path.Combine(Path.GetTempPath(), "CleanDubWebView");
            Directory.CreateDirectory(userDataFolder);
            
            var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(
                userDataFolder: userDataFolder);
            
            await webView.EnsureCoreWebView2Async(env);
            
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            
            var htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dedup_ui.html");
            if (File.Exists(htmlPath))
            {
                webView.CoreWebView2.Navigate(new Uri(htmlPath).AbsoluteUri);
            }
            else
            {
                webView.CoreWebView2.NavigateToString(
                    "<html><body style='background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
                    "<div style='text-align:center'><h1>找不到界面文件</h1><p>请确保 dedup_ui.html 与 exe 在同一目录</p></div></body></html>");
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("初始化失败: " + ex.Message + "\n\n请确保已安装 WebView2 Runtime", "错误", 
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            Application.Exit();
        }
    }
}
