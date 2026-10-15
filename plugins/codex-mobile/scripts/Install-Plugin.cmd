@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "PLUGIN_INSTALL_ROOT=%~dp0"
if not exist "%PLUGIN_INSTALL_ROOT%Install-Plugin.ps1" set "PLUGIN_INSTALL_ROOT=%~dp0..\"
if "%~1"=="" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PLUGIN_INSTALL_ROOT%Install-Plugin.ps1" -OneClick
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PLUGIN_INSTALL_ROOT%Install-Plugin.ps1" -OneClick -InstallationRoot "%~1"
)
set "PLUGIN_INSTALL_EXIT=%ERRORLEVEL%"
exit /b %PLUGIN_INSTALL_EXIT%
