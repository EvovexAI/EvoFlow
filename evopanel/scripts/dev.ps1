#!/usr/bin/env pwsh
# EvoPanel 开发环境启动脚本 (Windows)
# 用法: .\scripts\dev.ps1

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
    Write-Host "`n▶ $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
    Write-Host "  ✓ $msg" -ForegroundColor Green
}

function Write-Fail([string]$msg) {
    Write-Host "  ✗ $msg" -ForegroundColor Red
}

function Write-Warn([string]$msg) {
    Write-Host "  ⚠ $msg" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  EvoPanel 开发环境" -ForegroundColor Magenta
Write-Host "  ─────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# ── 环境检查 ──────────────────────────────────────────────────────

Write-Step "检查开发环境"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "未找到 Node.js,请从 https://nodejs.org 安装 v18+"
    exit 1
}
$nodeVer = (node --version)
Write-Ok "Node.js $nodeVer"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail "未找到 npm"
    exit 1
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Warn "未找到 Rust/Cargo (仅桌面开发需要)"
    Write-Host "    Web 开发可忽略,桌面开发请从 https://rustup.rs 安装" -ForegroundColor DarkGray
} else {
    $rustVer = (rustc --version)
    Write-Ok "Rust $rustVer"
}

# ── 安装依赖 ──────────────────────────────────────────────────────

Write-Step "检查前端依赖"
if (-not (Test-Path "node_modules")) {
    Write-Host "  首次安装依赖,请稍候..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "依赖安装失败"; exit 1 }
    Write-Ok "依赖安装完成"
} else {
    Write-Ok "依赖已存在"
}

# ── 启动开发服务器 ─────────────────────────────────────────────────

Write-Host ""
Write-Host "  启动开发服务器（安装包同款：Tauri 自管 Gateway+stdio）..." -ForegroundColor Green
Write-Host "  ─────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

Remove-Item Env:EVOFLOW_GATEWAY_URL -ErrorAction SilentlyContinue
Remove-Item Env:VITE_EVOFLOW_GATEWAY_URL -ErrorAction SilentlyContinue
# evopanel/scripts → repo backend is ../backend from evopanel/
$repoBackend = Join-Path (Split-Path $PSScriptRoot -Parent) 'backend'
if (Test-Path -LiteralPath $repoBackend) {
    $env:EVOFLOW_BACKEND_DIR = (Resolve-Path -LiteralPath $repoBackend).Path
    $venvPy = Join-Path $env:EVOFLOW_BACKEND_DIR '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venvPy) { $env:EVOPANEL_APP_SERVER_PYTHON = $venvPy }
}

npm run tauri dev
