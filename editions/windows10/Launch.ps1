[CmdletBinding()]
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path $PSScriptRoot 'Codex-Mobile.exe'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw '未找到本版 Codex-Mobile.exe，请完整解压 Windows 10 专用版。' }
# All discovery, Windows 10 build / native x64 validation and startup use this edition's launcher.
# This wrapper never bypasses the native launcher's checks or launches a second server itself.
if ($Check) {
    $checkProcess = Start-Process -FilePath $launcherPath -ArgumentList '--check' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -Wait
    exit $checkProcess.ExitCode
}
Start-Process -FilePath $launcherPath -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
Write-Host 'Codex 移动助手 · Windows 10 专用版 V1.0 启动器已打开。'
