#!/usr/bin/env pwsh
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host '[*] Starting EvoPanel dev server (installer pack mode: Tauri owns Gateway+stdio)...' -ForegroundColor Cyan

# Same as NSIS install: do not point at an external Gateway.
Remove-Item Env:EVOFLOW_GATEWAY_URL -ErrorAction SilentlyContinue
Remove-Item Env:VITE_EVOFLOW_GATEWAY_URL -ErrorAction SilentlyContinue

$repoBackend = Join-Path $PSScriptRoot '..\backend'
if (Test-Path -LiteralPath $repoBackend) {
    $env:EVOFLOW_BACKEND_DIR = (Resolve-Path -LiteralPath $repoBackend).Path
    $venvPy = Join-Path $env:EVOFLOW_BACKEND_DIR '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venvPy) {
        $env:EVOPANEL_APP_SERVER_PYTHON = $venvPy
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '[ERR] Node.js not found' -ForegroundColor Red; exit 1 }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Write-Host '[ERR] Rust not found' -ForegroundColor Red; exit 1 }
if (-not (Test-Path 'node_modules')) { Write-Host '[*] Installing deps...' -ForegroundColor Yellow; npm install }
if (-not (Test-Path 'src-tauri\target')) { Write-Host '[*] First Rust build (may take minutes)...' -ForegroundColor Yellow }

Write-Host '[*] Launching...' -ForegroundColor Green
npm run tauri dev
