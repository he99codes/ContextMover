Add-Type -AssemblyName System.Drawing

$outDir = "$PSScriptRoot\public\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($size in @(16, 32, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # Dark background
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(5, 5, 5))
    $g.FillRectangle($bgBrush, 0, 0, $size, $size)
    $bgBrush.Dispose()

    # Green circle border
    $strokeW = [float][Math]::Max(1.5, $size / 22.0)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(0, 255, 136), $strokeW)
    $pad = [int]($size * 0.10)
    $g.DrawEllipse($pen, $pad, $pad, $size - $pad * 2, $size - $pad * 2)
    $pen.Dispose()

    # Green center dot
    $r = [int]($size * 0.18)
    $cx = [int]($size / 2 - $r)
    $cy = [int]($size / 2 - $r)
    $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 255, 136))
    $g.FillEllipse($dotBrush, $cx, $cy, $r * 2, $r * 2)
    $dotBrush.Dispose()

    $g.Dispose()
    $outPath = "$outDir\icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created $outPath"
}

Write-Host "All icons generated."
