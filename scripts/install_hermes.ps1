# scripts/install_hermes.ps1 — Installer resmi Hermes Agent (Nous Research)
# Menjalankan install.ps1 resmi secara non-interaktif untuk integrasi VM-Panel.
param(
    [string]$HermesHome = "$env:LOCALAPPDATA\hermes",
    [switch]$SkipComputerUse
)

$ErrorActionPreference = "Stop"
Write-Host "[install_hermes] Memulai instalasi Hermes Agent resmi (Nous Research)..." -ForegroundColor Cyan
Write-Host "[install_hermes] Target direktori: $HermesHome" -ForegroundColor Gray

# 1. Download installer resmi dari nousresearch.com
$installerUrl = "https://hermes-agent.nousresearch.com/install.ps1"
$tempScript = Join-Path $env:TEMP "hermes-install-$([guid]::NewGuid().ToString('N')).ps1"

try {
    Write-Host "[install_hermes] Mengunduh script installer dari $installerUrl..."
    Invoke-WebRequest -Uri $installerUrl -OutFile $tempScript -UseBasicParsing

    Write-Host "[install_hermes] Menjalankan installer resmi (-NonInteractive -SkipSetup)..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempScript -NonInteractive -SkipSetup -HermesHome $HermesHome
    
    Write-Host "[install_hermes] Instalasi selesai!" -ForegroundColor Green
}
catch {
    Write-Error "[install_hermes] GAGAL menginstal Hermes Agent: $_"
    exit 1
}
finally {
    if (Test-Path $tempScript) {
        Remove-Item -Force $tempScript -ErrorAction SilentlyContinue
    }
}
