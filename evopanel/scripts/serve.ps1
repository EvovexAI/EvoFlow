#!/usr/bin/env pwsh
# EvoPanel Web 版启动脚本 (无需 Rust/Tauri)
# 适用于: 开发前端 / 服务器部署 / Docker
# 用法:
#   .\scripts\serve.ps1              # 启动 Web 服务 (默认端口 1420)
#   .\scripts\serve.ps1 -Port 8080   # 自定义端口

param(
    [int]$Port = 1420,
    [string]$Host_IP = "0.0.0.0"
)

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

Write-Host ""
Write-Host "  EvoPanel Web 版" -ForegroundColor Magenta
Write-Host "  ─────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  无需 Rust/Tauri,纯前端 + Node.js 后端" -ForegroundColor DarkGray
Write-Host ""

# ── 环境检查 ──────────────────────────────────────────────────────

Write-Step "检查环境"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "未找到 Node.js,请从 https://nodejs.org 安装 v18+"
    exit 1
}
$nodeVer = (node --version)
Write-Ok "Node.js $nodeVer"

# ── 安装依赖 ──────────────────────────────────────────────────────

Write-Step "检查依赖"
if (-not (Test-Path "node_modules")) {
    Write-Host "  安装依赖中..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "依赖安装失败"; exit 1 }
    Write-Ok "依赖安装完成"
} else {
    Write-Ok "依赖已存在"
}

# ── 构建前端 ─────────────────────────────────────────────────────

Write-Step "构建前端"
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Fail "前端构建失败"
    exit 1
}
Write-Ok "前端构建完成"

# ── 启动 Web 服务 ─────────────────────────────────────────────────

Write-Host ""
Write-Host "  启动 Web 服务..." -ForegroundColor Green
Write-Host "  ─────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  地址: http://$Host_IP`:$Port" -ForegroundColor Cyan
Write-Host "  本地访问: http://localhost:$Port" -ForegroundColor Cyan
Write-Host ""
Write-Host "  按 Ctrl+C 停止服务" -ForegroundColor DarkGray
Write-Host ""

node scripts/serve.js --port $Port --host $Host_IP
