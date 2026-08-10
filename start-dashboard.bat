@echo off
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0start-dashboard.ps1"
exit /b %ERRORLEVEL%
