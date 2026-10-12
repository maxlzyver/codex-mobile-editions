[CmdletBinding()]
param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
$launcherRoot = $PSScriptRoot
$launcherSource = Join-Path $launcherRoot 'launcher\Launcher.cs'
$launcherOutput = if ([string]::IsNullOrWhiteSpace($OutputPath)) { Join-Path $launcherRoot 'Codex-Mobile.exe' } else { [System.IO.Path]::GetFullPath($OutputPath) }
$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$launcherCompiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $launcherCompiler) { throw '.NET Framework 4 C# compiler was not found. Build this launcher on Windows 10 with .NET Framework 4.8.' }
if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) { throw 'launcher\Launcher.cs is missing.' }

# Compile the native Windows launcher without Node, npm, downloads, or shell command construction.
& $launcherCompiler /nologo /target:winexe /platform:x64 /optimize+ /utf8output `
    /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll `
    "/out:$launcherOutput" $launcherSource
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed with exit code $LASTEXITCODE." }
Write-Host 'Built Codex-Mobile.exe: Codex Mobile Assistant Windows 10 专用版 1.0.1 by maxlzyver, Windows 10 x64. No program was launched.'
