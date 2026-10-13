param([Parameter(Mandatory=$true)][string]$SourceImage)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repository = Split-Path -Parent $PSScriptRoot
$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $SourceImage).Path)
try {
    $images = @{}
    foreach ($size in @(16,32,48,64,128,180,192,256,512)) {
        $bitmap = New-Object System.Drawing.Bitmap($size, $size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::White)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scale = [Math]::Min($size / $source.Width, $size / $source.Height)
            $width = [int]($source.Width * $scale); $height = [int]($source.Height * $scale)
            $graphics.DrawImage($source, [int](($size-$width)/2), [int](($size-$height)/2), $width, $height)
            $stream = New-Object System.IO.MemoryStream
            try { $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); $images[$size] = $stream.ToArray() }
            finally { $stream.Dispose() }
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
    $iconStream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($iconStream)
    try {
        $sizes = @(16,32,48,64,128,256)
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        foreach ($size in $sizes) {
            $dimension = if ($size -eq 256) { 0 } else { $size }
            $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
            $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$images[$size].Length); $writer.Write([uint32]$offset)
            $offset += $images[$size].Length
        }
        foreach ($size in $sizes) { $writer.Write([byte[]]$images[$size]) }
        $writer.Flush(); $icon = $iconStream.ToArray()
    } finally { $writer.Dispose(); $iconStream.Dispose() }
    foreach ($edition in @('windows11','windows10','macos')) {
        $public = Join-Path $repository "editions/$edition/public"
        [IO.File]::WriteAllBytes((Join-Path $public 'app-icon.png'), $images[128])
        [IO.File]::WriteAllBytes((Join-Path $public 'app-icon-192.png'), $images[192])
        [IO.File]::WriteAllBytes((Join-Path $public 'app-icon-512.png'), $images[512])
        [IO.File]::WriteAllBytes((Join-Path $public 'apple-touch-icon.png'), $images[180])
        [IO.File]::WriteAllBytes((Join-Path $public 'favicon.ico'), $icon)
    }
} finally { $source.Dispose() }
Write-Output 'Converted the supplied artwork to application icon formats for all three editions.'
