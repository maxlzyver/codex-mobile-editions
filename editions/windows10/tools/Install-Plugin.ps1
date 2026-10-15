[CmdletBinding()]
param([string]$DefaultCwd, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$editionRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resultFile = Join-Path $editionRoot '.runtime\plugin-install-result.txt'
try {
  $node = Join-Path $editionRoot 'runtime\node.exe'
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '缺少完整软件包自带的 Node.js，请完整解压 Windows 专用版后重试。' }
  $documents = [Environment]::GetFolderPath('MyDocuments')
  if (-not $documents) { $documents = Join-Path $env:USERPROFILE 'Documents' }
  $arguments = @((Join-Path $editionRoot 'lib\install-plugin.mjs'), '--documents-dir', $documents)
  if ($DefaultCwd) { $arguments += @('--default-cwd', [IO.Path]::GetFullPath($DefaultCwd)) }
  if ($DataDir) { $arguments += @('--data-dir', [IO.Path]::GetFullPath($DataDir)) }
  & $node @arguments
  exit $LASTEXITCODE
} catch {
  $message = $_.Exception.Message
  try { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resultFile)) | Out-Null; [IO.File]::WriteAllText($resultFile, $message, [Text.UTF8Encoding]::new($false)) } catch { }
  [Console]::Error.WriteLine($message)
  [Console]::Error.WriteLine('安装结果：' + $resultFile)
  exit 1
}
