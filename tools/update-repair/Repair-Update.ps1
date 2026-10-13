[CmdletBinding()]
param([string]$InstallDirectory)
$ErrorActionPreference = 'Stop'
try {
    if ([string]::IsNullOrWhiteSpace($InstallDirectory)) {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Select the OLD Codex Mobile folder (contains Codex-Mobile.exe). Exit its tray app first; do not close official Codex.'
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
        $InstallDirectory = $dialog.SelectedPath
    }
    $target = [IO.Path]::GetFullPath($InstallDirectory)
    $node = Join-Path $target 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Select a COMPLETE old portable installation containing runtime\node.exe.' }
    & $node (Join-Path $PSScriptRoot 'repair-update.mjs') --root $target
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch { Write-Host $_.Exception.Message; exit 1 }
