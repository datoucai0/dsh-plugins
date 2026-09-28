@echo off
rem ============================================
rem  dsh-message-preview - one-click installer
rem  Self-contained: no manual config needed.
rem ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo [message-preview] Install FAILED. See messages above.
  pause
  exit /b 1
)
echo.
echo [message-preview] Installed. Fully stop and restart dsh web to apply.
echo [message-preview] Refreshing the browser alone is not enough.
pause
