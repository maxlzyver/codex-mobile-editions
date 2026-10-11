[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path $PSScriptRoot 'Codex-Mobile.exe'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw '未找到本版 Codex-Mobile.exe，请从完整的 Windows 11 专用版 文件夹执行。' }
# --stop verifies this directory's server root, PID/start time, loopback URL and owner session.
# It sends the normal shutdown request; it does not terminate the original Codex desktop app.
$stopProcess = Start-Process -FilePath $launcherPath -ArgumentList '--stop' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -Wait
if ($stopProcess.ExitCode -ne 0) { throw '未能正常停止本目录的移动助手，请从托盘菜单退出后重试。' }
Write-Host 'Codex 移动助手 · Windows 11 专用版：本目录控制台已停止或未在运行。'
