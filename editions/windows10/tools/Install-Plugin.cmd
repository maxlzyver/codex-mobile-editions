@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "EDITION_PLUGIN_ROOT=%~dp0"
if not exist "%EDITION_PLUGIN_ROOT%lib\install-plugin.mjs" set "EDITION_PLUGIN_ROOT=%~dp0..\"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EDITION_PLUGIN_ROOT%tools\Install-Plugin.ps1" %*
exit /b %ERRORLEVEL%
