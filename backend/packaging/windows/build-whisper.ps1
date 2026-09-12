# Build whisper_server.py into a standalone .exe (optional).
# Most users should just run `python whisper_server.py --model small` directly.
# Only use this script if you need a self-contained .exe without Python installed.
#
# Whisper model (~500MB for "small") auto-downloads on first use from Azure CDN
# (usually accessible in China). If blocked, pre-download via modelscope:
#   pip install modelscope
#   python -c "from modelscope import snapshot_download; snapshot_download('AI-ModelScope/whisper-small', cache_dir='~/.cache/whisper')"

$ErrorActionPreference = 'Stop'

$scriptRoot  = $PSScriptRoot
$backendRoot = Join-Path $scriptRoot "..\.."
$voiceDir    = Join-Path $backendRoot "app\gateway\speech"
$distDir     = Join-Path $backendRoot "whisper-dist"

Write-Host "[build-whisper] Checking dependencies..." -ForegroundColor Cyan
pip install pyinstaller openai-whisper websockets numpy tiktoken --quiet
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Write-Host "[build-whisper] Running PyInstaller (this takes a few minutes)..." -ForegroundColor Cyan
Push-Location $voiceDir
try {
    pyinstaller `
        --noconfirm `
        --clean `
        --onedir `
        --name whisper_server `
        --collect-all whisper `
        --collect-all tiktoken `
        --hidden-import "websockets.server" `
        --hidden-import "websockets.legacy" `
        --hidden-import "websockets.legacy.server" `
        --hidden-import "tiktoken_ext" `
        --hidden-import "tiktoken_ext.openai_public" `
        --hidden-import "tqdm" `
        --hidden-import "tqdm.auto" `
        --hidden-import "numpy" `
        --hidden-import "numpy.core._methods" `
        --exclude-module "matplotlib" `
        --exclude-module "PIL" `
        --exclude-module "IPython" `
        --exclude-module "tensorflow" `
        --exclude-module "jupyter" `
        --exclude-module "notebook" `
        whisper_server.py

    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

    Write-Host "[build-whisper] Moving output to whisper-dist/..." -ForegroundColor Cyan
    if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
    Move-Item (Join-Path $voiceDir "dist\whisper_server") $distDir

    # Copy models dir if it exists (user must download whisper models first)
    $modelDir = Join-Path $voiceDir "..\..\..\data\whisper-models"
    if (Test-Path $modelDir) {
        Copy-Item $modelDir (Join-Path $distDir "models") -Recurse
        Write-Host "[build-whisper] Whisper models copied from cache" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "================================================" -ForegroundColor Green
    Write-Host "[build-whisper] Done!" -ForegroundColor Green
    Write-Host "  Output: $distDir" -ForegroundColor Green
    Write-Host "  The whisper-server.exe binary + deps are in the _internal/ subfolder" -ForegroundColor Green
    Write-Host ""
    Write-Host "  To use: start whisper-server.exe --model small" -ForegroundColor Yellow
    Write-Host "  The first run will auto-download the model (~1-3GB) if not cached." -ForegroundColor Yellow
    Write-Host "  Cache whisper models in data/whisper-models/ to skip download." -ForegroundColor Yellow
    Write-Host "================================================" -ForegroundColor Green
} finally {
    $buildDir = Join-Path $voiceDir "build"
    $distPyi  = Join-Path $voiceDir "dist"
    $specFile = Join-Path $voiceDir "whisper_server.spec"
    if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
    if (Test-Path $distPyi)  { Remove-Item $distPyi  -Recurse -Force }
    if (Test-Path $specFile) { Remove-Item $specFile }
    Pop-Location
}
