# EvoPanel build script (Windows). ASCII-only for PS 5.1 + cmd compatibility.
# Usage:
#   .\scripts\build.ps1           Release installer (calls build-installer-win.ps1)
#   .\scripts\build.ps1 -Debug    Debug build, no NSIS
#   .\scripts\build.ps1 -Clean    cargo clean then release

param(
    [switch]$Debug,
    [switch]$Clean
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "[step] $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
    Write-Host "  [ok] $msg" -ForegroundColor Green
}

function Write-Fail([string]$msg) {
    Write-Host "  [fail] $msg" -ForegroundColor Red
}

function Write-Warn([string]$msg) {
    Write-Host "  [warn] $msg" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  EvoPanel build (Windows x64)" -ForegroundColor Magenta
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray
Write-Host ""

Write-Step "Check toolchain"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js not found. Install from https://nodejs.org (v18+)"
    exit 1
}
$nodeVer = (node --version)
Write-Ok "Node.js $nodeVer"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail "npm not found"
    exit 1
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Fail "Rust/Cargo not found. Install from https://rustup.rs"
    exit 1
}
$rustVer = (rustc --version)
Write-Ok "Rust $rustVer"

$webview2Key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
if (-not (Test-Path $webview2Key)) {
    Write-Warn "WebView2 Runtime not detected (end users may need it)"
    Write-Host "    https://developer.microsoft.com/microsoft-edge/webview2/" -ForegroundColor DarkGray
}

Write-Step "npm dependencies"
if (-not (Test-Path "node_modules")) {
    npm ci --silent
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm ci failed"; exit 1 }
    Write-Ok "npm ci done"
} else {
    Write-Ok "node_modules exists, skip npm ci"
}

if ($Clean) {
    Write-Step "cargo clean"
    Push-Location src-tauri
    cargo clean
    Pop-Location
    Write-Ok "cargo clean done"
}

$startTime = Get-Date

if ($Debug) {
    Write-Step "Debug build (no installer)"
    npm run tauri build -- --debug
} else {
    Write-Step "Release build (backend sidecar + NSIS)"
    Write-Host "  Uses build-installer-win.ps1: backend -> binaries -> NSIS" -ForegroundColor DarkGray
    Write-Host ""
    $installerScript = Join-Path $PSScriptRoot "build-installer-win.ps1"
    $verifyAscii = Join-Path $PSScriptRoot "verify-ps1-ascii.ps1"
    if (Test-Path $installerScript) {
        if (Test-Path $verifyAscii) {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $verifyAscii $installerScript $verifyAscii
            if ($LASTEXITCODE -ne 0) { Write-Fail "PowerShell scripts must be ASCII-only (see verify-ps1-ascii.ps1)"; exit 1 }
        }
        & powershell -NoProfile -ExecutionPolicy Bypass -File $installerScript
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "build-installer-win.ps1 failed"
            exit 1
        }
    } else {
        Write-Fail "build-installer-win.ps1 not found"
        exit 1
    }
}

if ($LASTEXITCODE -ne 0) {
    Write-Fail "build failed"
    exit 1
}

$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)

Write-Host ""
Write-Host "  Build finished in ${elapsed}s" -ForegroundColor Green
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray

$bundleDir = "src-tauri\target\release\bundle"
if ($Debug) {
    $exePath = "src-tauri\target\debug\evoflow.exe"
    Write-Host "  Output exe: $exePath" -ForegroundColor White
} else {
    Write-Host "  Bundle dir: $bundleDir" -ForegroundColor White
    $exe = Get-ChildItem "$bundleDir\nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) {
        Write-Host "  NSIS setup: $($exe.FullName)" -ForegroundColor Green
        Write-Host ""
        Write-Host "  Run the setup exe to install." -ForegroundColor DarkGray
    } else {
        Write-Warn "No *-setup.exe found under nsis\"
    }
}

Write-Host ""
Write-Host "  Cross-platform CI: push a tag, e.g." -ForegroundColor DarkGray
Write-Host '    git tag v0.1.0' -ForegroundColor DarkGray
Write-Host '    git push origin v0.1.0' -ForegroundColor DarkGray
Write-Host ""
