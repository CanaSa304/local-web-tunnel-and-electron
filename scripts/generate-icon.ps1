# 从 src/logo.png 生成多尺寸 build/icon.ico（Windows 应用 / 快捷方式图标）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\generate-icon.ps1
param(
  [string]$Source = "src/logo.png",
  [string]$Output = "build/icon.ico"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$srcPath = (Resolve-Path $Source).Path
$src = [System.Drawing.Bitmap]::FromFile($srcPath)

# 需要包含的图标尺寸（含 256，Windows 图标规范最大尺寸）
$sizes = 16, 24, 32, 48, 64, 128, 256

function Get-ResizedPng([System.Drawing.Bitmap]$bmp, [int]$size) {
  $nb = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($nb)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($bmp, 0, 0, $size, $size)
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $nb.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $ms.Dispose()
  $nb.Dispose()
  return ,$png
}

$images = @()
foreach ($s in $sizes) {
  $images += , @($s, (Get-ResizedPng $src $s))
}

$outFull = if ([System.IO.Path]::IsPathRooted($Output)) {
  $Output
} else {
  Join-Path (Get-Location) $Output
}
$outDir = Split-Path $outFull -Parent
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$finalPath = Join-Path $outDir (Split-Path $Output -Leaf)

$count = $images.Count
$fs = New-Object System.IO.FileStream($finalPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR：reserved=0, type=1(icon), count
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$count)

$offset = 6 + 16 * $count
foreach ($img in $images) {
  $size = $img[0]
  $data = $img[1]
  # ICONDIRENTRY：宽/高（0 表示 256）
  if ($size -ge 256) {
    $bw.Write([Byte]0)
    $bw.Write([Byte]0)
  } else {
    $bw.Write([Byte]$size)
    $bw.Write([Byte]$size)
  }
  $bw.Write([Byte]0) # color count
  $bw.Write([Byte]0) # reserved
  $bw.Write([UInt16]1)  # planes
  $bw.Write([UInt16]32) # bit count
  $bw.Write([UInt32]$data.Length)
  $bw.Write([UInt32]$offset)
  $offset += $data.Length
}

foreach ($img in $images) {
  $bw.Write($img[1])
}

$bw.Flush()
$bw.Close()
$fs.Close()
$src.Dispose()

Write-Host "已生成 $Output（$count 种尺寸）"
