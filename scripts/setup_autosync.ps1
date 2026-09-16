# scripts/setup_autosync.ps1 — Registrasi otomatis Windows Scheduled Task untuk sinkronisasi port VPS.
# Berjalan di background tiap 5 menit secara senyap tanpa popup jendela.
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$vbsLauncher = Join-Path $rootDir 'bin\run-silent-sync.vbs'
$syncScript = Join-Path $rootDir 'bin\sync-port.mjs'

if (-not (Test-Path $vbsLauncher)) {
    # Generate launcher jika belum ada
    @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node ""$syncScript"" --silent", 0, False
"@ | Set-Content -Path $vbsLauncher -Encoding ASCII
}

$taskName = "VPanel-PortSync"
$taskRun = "wscript.exe //B `"$vbsLauncher`""

# Daftarkan Scheduled Task berulang tiap 5 menit
& schtasks.exe /create /tn $taskName /tr $taskRun /sc minute /mo 5 /f | Out-Null

if ($LASTEXITCODE -eq 0) {
    # Jalankan sinkronisasi pertama kali
    & schtasks.exe /run /tn $taskName | Out-Null
    Write-Host "[v] Windows Background Task '$taskName' aktif!" -ForegroundColor Green
    Write-Host "    Interval  : Setiap 5 menit (100% senyap tanpa popup)" -ForegroundColor Cyan
    Write-Host "    Target    : Auto-sync port VPS ke ~/.ssh/config" -ForegroundColor Cyan
    Write-Host "    Hasil     : Anda tidak perlu lagi menjalankan perintah apa pun!" -ForegroundColor Green
} else {
    Write-Error "Gagal mendaftarkan task '$taskName'"
}
