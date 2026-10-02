@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Duplicate-file cleaner for WeChat data (local web UI)
rem  Engine: dedup_core.ps1 + dedup_server.ps1
rem  UI    : dedup_ui.html
rem
rem  Usage:
rem    double-click          -> pick a free port, open browser
rem    run.bat -Port 9000    -> fixed port
rem    run.bat -NoBrowser    -> do not open browser
rem  Stop: Ctrl+C in this window, or "close service" in the page.
rem ============================================================

if not exist "%~dp0dedup_server.ps1" (
  echo [ERROR] dedup_server.ps1 not found next to this launcher.
  pause
  exit /b 1
)

echo Starting local dedup service ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dedup_server.ps1" %*
echo.
echo Service stopped.
pause
