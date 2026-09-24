#requires -Version 5.1
<#
.SYNOPSIS
  使用代码签名证书对 Windows 文件（exe/dll/msi/cab 等）进行 Authenticode 签名。

.DESCRIPTION
  证书来源（按优先级）：
    1) 环境变量 WINDOWS_CERTIFICATE_FILE  + WINDOWS_CERTIFICATE_PASSWORD（.pfx 证书）
    2) 环境变量 WINDOWS_CERTIFICATE_THUMBPRINT（当前用户证书库 CurrentUser\My 中
       已安装的代码签名证书）
  时间戳（防证书过期后签名失效）：
    环境变量 WINDOWS_TIMESTAMP_SERVER 可指定单个 RFC3161 时间戳服务器；
    未设置时依次尝试内置的 DigiCert / Sectigo / Starfield 公共服务器，
    全部不可达则不加时间戳并给出警告（签名仍有效，但会随证书过期而失效）。

.PARAMETER Paths
  要签名的文件绝对路径列表。

.EXAMPLE
  # 准备证书（发布正式版时使用 CA 签发的代码签名证书）
  $env:WINDOWS_CERTIFICATE_FILE = 'C:\certs\pashpon-code-signing.pfx'
  $env:WINDOWS_CERTIFICATE_PASSWORD = '******'

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sign.ps1 `
      -Paths .\out\make\wix\x64\maxbox.msi, .\out\maxbox-win32-x64\maxbox.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Paths
)

$ErrorActionPreference = 'Stop'

# ---------- 1. 解析证书 ----------
$cert = $null
$pfxFile = $env:WINDOWS_CERTIFICATE_FILE
$pfxPassword = $env:WINDOWS_CERTIFICATE_PASSWORD
$thumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT

if ($thumbprint) {
    $cert = Get-Item "Cert:\CurrentUser\My\$thumbprint" -ErrorAction Stop
    Write-Host "[sign] 使用证书库证书: $($cert.Subject)"
}
elseif ($pfxFile) {
    if (-not (Test-Path $pfxFile)) {
        Write-Error "[sign] 找不到证书文件: $pfxFile"
    }
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
        (Resolve-Path $pfxFile).Path,
        $pfxPassword,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
    )
    Write-Host "[sign] 使用证书文件: $pfxFile"
    Write-Host "[sign] 证书主体: $($cert.Subject)"
}
else {
    Write-Warning "[sign] 未检测到代码签名证书。请设置 WINDOWS_CERTIFICATE_FILE(+PASSWORD)"
    Write-Warning "[sign] 或 WINDOWS_CERTIFICATE_THUMBPRINT 后重试，本次跳过签名。"
    exit 2
}

# 证书必须包含私钥且用于代码签名
if (-not $cert.HasPrivateKey) {
    Write-Error "[sign] 证书不包含私钥，无法签名: $($cert.Subject)"
}

# ---------- 2. 时间戳服务器 ----------
$envServer = $env:WINDOWS_TIMESTAMP_SERVER
if ($envServer) {
    $timestampServers = @($envServer)
}
else {
    $timestampServers = @(
        'http://timestamp.digicert.com',
        'http://timestamp.sectigo.com',
        'http://tsa.starfieldtech.com'
    )
}

# ---------- 3. 逐个签名 ----------
function Set-AuthenticodeSignatureSafe {
    param(
        [string]$FilePath,
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
        [string]$TimestampServer
    )
    if ($TimestampServer) {
        Set-AuthenticodeSignature -FilePath $FilePath -Certificate $Certificate `
            -HashAlgorithm SHA256 -TimestampServer $TimestampServer
    }
    else {
        Set-AuthenticodeSignature -FilePath $FilePath -Certificate $Certificate `
            -HashAlgorithm SHA256
    }
}

$failed = 0
foreach ($p in $Paths) {
    $abs = (Resolve-Path $p -ErrorAction Stop).Path
    $sig = $null
    foreach ($ts in $timestampServers) {
        try {
            $sig = Set-AuthenticodeSignatureSafe -FilePath $abs -Certificate $cert -TimestampServer $ts
            Write-Host "[sign] 已签名（时间戳: $ts）: $abs -> $($sig.Status)"
            break
        }
        catch {
            Write-Warning "[sign] 时间戳服务器不可用（$ts）：$($_.Exception.Message)"
        }
    }
    if (-not $sig) {
        # 所有时间戳服务器都不可达：降级为不带时间戳的签名（证书过期后签名将失效）
        try {
            $sig = Set-AuthenticodeSignatureSafe -FilePath $abs -Certificate $cert
            Write-Warning "[sign] 已签名但未加盖时间戳（请确保签名证书长期有效）: $abs -> $($sig.Status)"
        }
        catch {
            Write-Error "[sign] 签名失败: $abs $($_.Exception.Message)"
            $failed++
            continue
        }
    }
    $check = Get-AuthenticodeSignature -FilePath $abs
    Write-Host "[sign] 校验: $($check.Status)  签名者: $($check.SignerCertificate.Subject)"
}

if ($failed -gt 0) { exit 1 }
Write-Host "[sign] 全部完成。"
