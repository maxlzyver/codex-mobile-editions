[CmdletBinding()]
param([string]$InstallationRoot, [string]$DefaultCwd, [string]$DataDir, [switch]$Register)
$ErrorActionPreference = 'Stop'
if (-not $InstallationRoot) { $InstallationRoot = Read-Host '请输入 Editions 完整安装目录（包含 Codex-Mobile.exe）' }
$installation = (Resolve-Path -LiteralPath $InstallationRoot).Path
$node = Join-Path $installation 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '没有找到完整安装包自带的 runtime\node.exe。请先完整解压对应 Windows 专用版。' }
$setupArguments = @((Join-Path $PSScriptRoot 'scripts\setup.mjs'), '--installation-root', $installation)
if ($DefaultCwd) { $setupArguments += @('--default-cwd', (Resolve-Path -LiteralPath $DefaultCwd).Path) }
if ($DataDir) { $setupArguments += @('--data-dir', [IO.Path]::GetFullPath($DataDir)) }
if ($Register) { $setupArguments += '--register' }
& $node @setupArguments
if ($LASTEXITCODE -ne 0) { throw '插件安装未完成，请查看以上错误。' }
Write-Host '绑定完成。若尚未注册插件源，请将上方 marketplaceRoot 加入 Codex 本地插件源并安装 Codex 移动助手。'
Write-Host '然后在 Codex 中说“打开移动助手管理面板”，或从插件页面打开。'
