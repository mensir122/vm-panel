# scripts/create-shortcut.ps1 - Buat shortcut VM-Panel di Windows Desktop & Start Menu
param(
    [string]$TargetExe = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

if (-not $TargetExe) {
    $TargetExe = Join-Path $ProjectRoot "dist\win-unpacked\VM-Panel.exe"
}

$IconPath = Join-Path $ProjectRoot "desktop\assets\icon.ico"

if (-not (Test-Path $TargetExe)) {
    Write-Host "[VM-Panel] Peringatan: Executable belum ditemukan di: $TargetExe" -ForegroundColor Yellow
    Write-Host "[VM-Panel] Jalankan 'npm run desktop:build' terlebih dahulu untuk membuat executable." -ForegroundColor Yellow
}

$WshShell = New-Object -ComObject WScript.Shell

# 1. Desktop Shortcut
$desktopPath = [Environment]::GetFolderPath('Desktop')
if ($desktopPath -and (Test-Path $desktopPath)) {
    $desktopLnk = Join-Path $desktopPath "VM-Panel.lnk"
    $sc = $WshShell.CreateShortcut($desktopLnk)
    $sc.TargetPath = $TargetExe
    $sc.WorkingDirectory = $ProjectRoot
    if (Test-Path $IconPath) {
        $sc.IconLocation = $IconPath
    }
    $sc.Description = "VM-Panel - Native Desktop 24/7 Deployment Manager"
    $sc.Save()
    Write-Host "[VM-Panel] Shortcut Desktop berhasil dibuat: $desktopLnk" -ForegroundColor Green
}

# 2. Start Menu Shortcut
$programsPath = [Environment]::GetFolderPath('Programs')
if ($programsPath -and (Test-Path $programsPath)) {
    $startMenuLnk = Join-Path $programsPath "VM-Panel.lnk"
    $scSM = $WshShell.CreateShortcut($startMenuLnk)
    $scSM.TargetPath = $TargetExe
    $scSM.WorkingDirectory = $ProjectRoot
    if (Test-Path $IconPath) {
        $scSM.IconLocation = $IconPath
    }
    $scSM.Description = "VM-Panel - Native Desktop 24/7 Deployment Manager"
    $scSM.Save()
    Write-Host "[VM-Panel] Shortcut Start Menu berhasil dibuat: $startMenuLnk" -ForegroundColor Green
}
