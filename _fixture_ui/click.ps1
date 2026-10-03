param(
    [Parameter(Mandatory=$true)][int]$X,
    [Parameter(Mandatory=$true)][int]$Y,
    [int]$ProcessId = 13368
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ClickWin {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$proc = Get-Process -Id $ProcessId -ErrorAction Stop
$r = New-Object ClickWin+RECT
[ClickWin]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
[ClickWin]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 200
$sx = $r.Left + $X; $sy = $r.Top + $Y
[ClickWin]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 150
[ClickWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # left down
Start-Sleep -Milliseconds 60
[ClickWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # left up
Write-Host "clicked at screen ($sx, $sy)"
