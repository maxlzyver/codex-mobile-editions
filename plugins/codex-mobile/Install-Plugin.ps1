[CmdletBinding()]
param([string]$InstallationRoot, [string]$DefaultCwd, [string]$DataDir, [switch]$Register, [switch]$OneClick)
$ErrorActionPreference = 'Stop'
$automatic = $OneClick -or -not $PSBoundParameters.Count
$resultDir = if ($DataDir) { [IO.Path]::GetFullPath($DataDir) } elseif ($env:CODEX_MOBILE_PLUGIN_DATA) { [IO.Path]::GetFullPath($env:CODEX_MOBILE_PLUGIN_DATA) } else { Join-Path $env:LOCALAPPDATA 'CodexMobile\plugin' }
function Write-InstallResult([string]$Message) {
  try { [IO.Directory]::CreateDirectory($resultDir) | Out-Null; [IO.File]::WriteAllText((Join-Path $resultDir 'install-result.txt'), ((Get-Date).ToString('o') + "`r`n" + $Message), [Text.UTF8Encoding]::new($false)) } catch { }
}
function Test-Edition([string]$Directory) {
  try {
    if (-not $Directory -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
    $current = Get-Item -LiteralPath $Directory
    while ($current) { if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }; $current = $current.Parent }
    $profile = Get-Content -LiteralPath (Join-Path $Directory 'edition.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $package = Get-Content -LiteralPath (Join-Path $Directory 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($profile.id -notin @('windows10','windows11') -or $package.name -ne 'codex-mobile-console' -or $profile.version -ne $package.version) { return $false }
    $current = Get-Item -LiteralPath (Join-Path $Directory 'runtime\node.exe')
    while ($current) { if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }; $current = if ($current -is [IO.FileInfo]) { $current.Directory } else { $current.Parent } }
    return $true
  } catch { return $false }
}
try {
  if ($automatic -and -not $DataDir -and -not $env:CODEX_MOBILE_PLUGIN_DATA) {
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $cache = Join-Path $codexHome 'plugins\cache\codex-mobile-local\codex-mobile'
    foreach ($version in @(Get-ChildItem -LiteralPath $cache -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 50)) {
      try {
        $identity = Get-Content -LiteralPath (Join-Path $version.FullName 'plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($identity.name -ne 'codex-mobile' -or $identity.version -ne $version.Name) { continue }
        $candidate = (Get-Content -LiteralPath (Join-Path $version.FullName 'mcp.json') -Raw -Encoding UTF8 | ConvertFrom-Json).mcpServers.mobile.env.CODEX_MOBILE_PLUGIN_DATA
        if (-not $candidate -or -not [IO.Path]::IsPathRooted($candidate)) { continue }
        $cfg = Get-Content -LiteralPath (Join-Path $candidate 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.schema -ne 1 -or -not $cfg.installationRoot -or $cfg.pluginSourceRoot -ne (Join-Path $candidate 'marketplace\plugins\codex-mobile')) { continue }
        $resultDir = [IO.Path]::GetFullPath($candidate); break
      } catch { }
    }
  }
  $searchRoots = @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot), [Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Applications'))
  $bootstrapRoot = $null
  if ($InstallationRoot) {
    $InstallationRoot = (Resolve-Path -LiteralPath $InstallationRoot).Path
    if (-not (Test-Edition $InstallationRoot)) { throw '所选文件夹不是完整 Windows Editions 软件目录，或缺少自带的 runtime\node.exe。' }
    $bootstrapRoot = $InstallationRoot
  } elseif (-not $automatic) { throw '手动安装请指定 -InstallationRoot；双击 Install-Plugin.cmd 可自动查找并注册。' }
  else {
    try { $saved = (Get-Content -LiteralPath (Join-Path $resultDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).installationRoot; if (Test-Edition $saved) { $bootstrapRoot = $saved } } catch { }
    if (-not $bootstrapRoot) {
      $queue = [Collections.Generic.Queue[object]]::new(); $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($directory in $searchRoots) { if ($directory) { $queue.Enqueue(@{Directory=$directory; Depth=0}) } }
      $visited = 0
      while ($queue.Count -and $visited -lt 300 -and -not $bootstrapRoot) {
        $item = $queue.Dequeue(); $directory = [IO.Path]::GetFullPath($item.Directory)
        if (-not $seen.Add($directory) -or $directory.TrimEnd('\') -eq [IO.Path]::GetPathRoot($directory).TrimEnd('\')) { continue }
        $visited++
        if (Test-Edition $directory) { $bootstrapRoot = $directory; break }
        if ($item.Depth -ge 2 -or -not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Directory -ErrorAction SilentlyContinue)) { if (-not ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not $child.Name.StartsWith('.') -and $child.Name -notin @('runtime','node_modules','Library','AppData')) { $queue.Enqueue(@{Directory=$child.FullName; Depth=$item.Depth+1}) } }
      }
    }
    if (-not $bootstrapRoot) { throw '未找到 Editions 完整软件目录。请将完整解压的插件文件夹放在软件文件夹旁边后重试，或将软件文件夹拖到 Install-Plugin.cmd 上。' }
  }
  $node = Join-Path $bootstrapRoot 'runtime\node.exe'
  $entry = if ($automatic) { 'scripts\one-click.mjs' } else { 'scripts\setup.mjs' }
  $setupArguments = @((Join-Path $PSScriptRoot $entry))
  if ($InstallationRoot) { $setupArguments += @('--installation-root', $InstallationRoot) }
  if ($DefaultCwd) { $setupArguments += @('--default-cwd', [IO.Path]::GetFullPath($DefaultCwd)) }
  if ($DataDir -or $automatic) { $setupArguments += @('--data-dir', $resultDir) }
  if ($automatic) {
    $documents = [Environment]::GetFolderPath('MyDocuments'); if (-not $documents) { $documents = Join-Path $env:USERPROFILE 'Documents' }
    $setupArguments += @('--documents-dir', $documents)
    foreach ($directory in $searchRoots) { if ($directory) { $setupArguments += @('--search-root', $directory) } }
  } elseif ($Register) { $setupArguments += '--register' }
  & $node @setupArguments
  $installExit = $LASTEXITCODE
  if ($installExit -ne 0) { if (-not $automatic) { Write-InstallResult '手动插件安装未完成，请查看终端错误。' }; exit $installExit }
  if (-not $automatic) { $message = '绑定完成。使用 -Register 可完成注册。已注册后可从 Codex 插件详情打开移动助手。'; Write-Host $message; Write-InstallResult $message }
} catch { $message = $_.Exception.Message; Write-InstallResult $message; [Console]::Error.WriteLine($message); [Console]::Error.WriteLine('安装结果：' + (Join-Path $resultDir 'install-result.txt')); exit 1 }
