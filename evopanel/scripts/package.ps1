#!/usr/bin/env pwsh
# EvoPanel 打包脚本 - 生成独立 EXE 和安装包 (Windows)
# 用法:
#   .\scripts\package.ps1              # 打包 NSIS 安装包 (默认)
#   .\scripts\package.ps1 -ExeOnly     # 仅生成独立 EXE
#   .\scripts\package.ps1 -Both        # 同时生成 EXE 和安装包

param(
    [switch]$ExeOnly,
    [switch]$Both
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
Write-Host "  EvoPanel 打包工具" -ForegroundColor Magenta
Write-Host "  ─────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# ── 检查构建产物 ─────────────────────────────────────────────────

Write-Step "检查构建产物"

$bundleDir = "src-tauri\target\release\bundle"
if (-not (Test-Path $bundleDir)) {
    Write-Fail "未找到构建产物,请先运行 .\scripts\build.ps1"
    exit 1
}

Write-Ok "构建产物存在"

# ── 打包 ─────────────────────────────────────────────────────────

$startTime = Get-Date

if ($ExeOnly) {
    Write-Step "仅打包独立 EXE"
    # Tauri 默认会生成 EXE,无需额外操作
    $exe = Get-ChildItem "$bundleDir\nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
} elseif ($Both) {
    Write-Step "打包 EXE 和安装器"
    # 重新构建以确保最新
    npm run tauri build
} else {
    Write-Step "打包 NSIS 安装包"
    # 检查是否已有安装包
    $exe = Get-ChildItem "$bundleDir\nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) {
        Write-Host "  未找到安装包,重新构建..." -ForegroundColor Yellow
        npm run tauri build
    }
}

if ($LASTEXITCODE -ne 0) {
    Write-Fail "打包失败"
    exit 1
}

$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)

# ── 输出结果 ─────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ✓ 打包完成! 耗时 ${elapsed}s" -ForegroundColor Green
Write-Host "  ─────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# 列出生成的文件
$nsisDir = "$bundleDir\nsis"
if (Test-Path $nsisDir) {
    $files = Get-ChildItem $nsisDir -File
    if ($files.Count -gt 0) {
        Write-Host "  生成的文件:" -ForegroundColor White
        foreach ($file in $files) {
            $size = [math]::Round($file.Length / 1MB, 2)
            Write-Host "    📦 $($file.Name) ($size MB)" -ForegroundColor White
        }
        Write-Host ""
        Write-Host "  位置: $((Get-Item $nsisDir).FullName)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "  下一步:" -ForegroundColor Cyan
Write-Host "    1. 测试安装包: 双击 EXE 文件" -ForegroundColor DarkGray
Write-Host "    2. 发布到 GitHub Releases" -ForegroundColor DarkGray
Write-Host "    3. 更新下载链接" -ForegroundColor DarkGray
Write-Host ""
