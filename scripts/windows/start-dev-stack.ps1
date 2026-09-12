# One-command starter for local development.
#
# Default (Tauri desktop) = same process model as the installer:
#   Tauri owns ONE Gateway child (HTTP + stdio JSON-RPC). Do NOT set EVOFLOW_GATEWAY_URL.
#   No separate uvicorn window / mouthpiece.
#
# -WebOnly: Vite only; starts operator uvicorn and sets VITE_EVOFLOW_GATEWAY_URL.
# -ExternalGateway: legacy mouthpiece mode (separate uvicorn + EVOFLOW_GATEWAY_URL).
param(
    [switch] $WebOnly,
    [switch] $SkipBackend,
    [switch] $InstallEvoPanel,
    [switch] $ExternalGateway,
    [int] $FrontendPort = 1421,
    [switch] $AutoFrontendPort = $true,
    [int] $GatewayPort = 0
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ($GatewayPort -gt 0) {
    $env:EVOFLOW_GATEWAY_PORT = [string]$GatewayPort
}
. (Join-Path $PSScriptRoot "backend-common.ps1")
Initialize-EvoFlowBackendPaths -RepoRoot $RepoRoot
$EvoPanelDir = Join-Path $RepoRoot "evopanel"

function Test-PortListening {
    param([int] $Port)
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
        return $null -ne $conn
    } catch {
        return $false
    }
}

function Resolve-FrontendPort {
    param(
        [int] $PreferredPort,
        [bool] $AllowAutoFallback
    )
    if (-not (Test-PortListening -Port $PreferredPort)) {
        return $PreferredPort
    }
    if (-not $AllowAutoFallback) {
        throw "Frontend port $PreferredPort is already in use. Re-run with -AutoFrontendPort."
    }
    for ($p = $PreferredPort + 1; $p -le $PreferredPort + 30; $p++) {
        if (-not (Test-PortListening -Port $p)) {
            return $p
        }
    }
    throw "No available frontend port found in range $PreferredPort..$($PreferredPort + 30)."
}

function Resolve-GatewayUrl {
    if ($env:EVOFLOW_GATEWAY_URL -and $env:EVOFLOW_GATEWAY_URL.Trim()) {
        return @{
            Url    = $env:EVOFLOW_GATEWAY_URL.Trim()
            Source = "env:EVOFLOW_GATEWAY_URL"
        }
    }
    return @{
        Url    = "http://127.0.0.1:$($script:DFGatewayPort)"
        Source = "default dev backend port ($($script:DFGatewayPort))"
    }
}

function Test-GatewayHealthy {
    param([string] $BaseUrl)
    $url = "$($BaseUrl.TrimEnd('/'))/health"
    try {
        $resp = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 3
        return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
    } catch {
        return $false
    }
}

function Resolve-PackagedOrDistGatewayExe {
    $candidates = @(
        (Join-Path $EvoPanelDir "src-tauri\binaries\evoflow-gateway\evoflow-gateway.exe"),
        (Join-Path $RepoRoot "backend\dist\evoflow-gateway\evoflow-gateway.exe"),
        (Join-Path $RepoRoot "backend\dist\evoflow-gateway.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

if (-not (Test-Path $EvoPanelDir)) {
    throw "EvoPanel directory (evopanel) not found: $EvoPanelDir"
}
if (-not (Test-EvoFlowCommandExists "npm")) {
    throw "npm not found in PATH"
}
if (-not (Test-EvoFlowCommandExists "node")) {
    throw "node not found in PATH"
}

$tauriCliJs = Join-Path $EvoPanelDir 'node_modules/@tauri-apps/cli/tauri.js'
if (-not (Test-Path -LiteralPath $tauriCliJs)) {
    if ($InstallEvoPanel) {
        Write-Host ""
        Write-Host "[EvoFlow] EvoPanel node_modules missing; running npm ci in:" -ForegroundColor Cyan
        Write-Host "          $EvoPanelDir" -ForegroundColor DarkGray
        Push-Location -LiteralPath $EvoPanelDir
        try {
            $prevCi = $env:CI
            if ($prevCi) {
                Write-Host "[EvoFlow] Temporarily unsetting CI=$prevCi so npm shows progress (restored after npm ci)." -ForegroundColor DarkYellow
                Remove-Item Env:CI -ErrorAction SilentlyContinue
            }
            Write-Host "[EvoFlow] npm will print many lines (verbose). Spinner alone means extract/write is busy." -ForegroundColor DarkGray
            try {
                & npm ci --progress=true --loglevel verbose
                if ($LASTEXITCODE -ne 0) {
                    throw "npm ci failed in evopanel (exit code $LASTEXITCODE). Close apps locking node_modules or run npm ci manually in that folder."
                }
            } finally {
                if ($null -ne $prevCi -and $prevCi.Length -gt 0) {
                    $env:CI = $prevCi
                }
            }
        } finally {
            Pop-Location
        }
    }
}

# Desktop default = installer experience. Web / explicit -ExternalGateway keep operator uvicorn.
$usePackDesktop = (-not $WebOnly) -and (-not $ExternalGateway)

if ($usePackDesktop) {
    Write-Host ""
    Write-Host "==> Desktop pack mode (same as installer): Tauri owns Gateway + stdio" -ForegroundColor Cyan
    Write-Host "    No separate uvicorn window; no EVOFLOW_GATEWAY_URL; no mouthpiece." -ForegroundColor DarkGray

    # Clear external-gateway env so Rust takes the sidecar path.
    # IMPORTANT: only EVOFLOW_GATEWAY_URL means external; PORT alone is a bind hint.
    Remove-Item Env:EVOFLOW_GATEWAY_URL -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_EVOFLOW_GATEWAY_URL -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_EVOFLOW_GATEWAY_PORT -ErrorAction SilentlyContinue
    # Neutralize empty leftovers / dotenv re-inject of URL for this process tree.
    $env:EVOFLOW_GATEWAY_URL = ''
    $env:VITE_EVOFLOW_GATEWAY_URL = ''
    Write-Host "    Cleared EVOFLOW_GATEWAY_URL (pack mode — will spawn owned sidecar)" -ForegroundColor DarkGray

    if ($script:DFBackendDir -and (Test-Path -LiteralPath $script:DFBackendDir)) {
        $env:EVOFLOW_BACKEND_DIR = $script:DFBackendDir
        Write-Host "    EVOFLOW_BACKEND_DIR=$($env:EVOFLOW_BACKEND_DIR)" -ForegroundColor DarkGray
    }
    $venvPy = Join-Path $script:DFBackendDir ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPy) {
        $env:EVOPANEL_APP_SERVER_PYTHON = $venvPy
        Write-Host "    EVOPANEL_APP_SERVER_PYTHON=$venvPy (pack sidecar via gateway_entry if no exe)" -ForegroundColor DarkGray
    } else {
        Write-Host "    WARN: backend .venv missing — need binaries/ or uv sync" -ForegroundColor Yellow
    }

    $gwExe = Resolve-PackagedOrDistGatewayExe
    # Local pack mode: prefer editable gateway_entry.py + .venv (matches current config/schema).
    # Stale binaries/evoflow-gateway.exe often fails on config drift until the next installer build.
    # Opt into packaged exe: set EVOFLOW_USE_PACKAGED_SIDECAR=1
    $preferPackaged = $env:EVOFLOW_USE_PACKAGED_SIDECAR -and (
        $env:EVOFLOW_USE_PACKAGED_SIDECAR.Trim().ToLower() -in @('1', 'true', 'yes', 'on')
    )
    if ($preferPackaged -and $gwExe) {
        $env:EVOPANEL_BACKEND_EXE_PATH = $gwExe
        Write-Host "    EVOPANEL_BACKEND_EXE_PATH=$gwExe (EVOFLOW_USE_PACKAGED_SIDECAR=1)" -ForegroundColor DarkGray
    } elseif (Test-Path -LiteralPath $venvPy) {
        Remove-Item Env:EVOPANEL_BACKEND_EXE_PATH -ErrorAction SilentlyContinue
        Write-Host "    Sidecar launch: gateway_entry.py + .venv (editable; same stdio model as installer)" -ForegroundColor DarkGray
        if ($gwExe) {
            Write-Host "    (found $gwExe but ignored unless EVOFLOW_USE_PACKAGED_SIDECAR=1)" -ForegroundColor DarkGray
        }
    } elseif ($gwExe) {
        $env:EVOPANEL_BACKEND_EXE_PATH = $gwExe
        Write-Host "    EVOPANEL_BACKEND_EXE_PATH=$gwExe (no .venv; using packaged/dist exe)" -ForegroundColor DarkGray
    } else {
        Write-Host "    WARN: no .venv python and no evoflow-gateway.exe — sidecar spawn will fail" -ForegroundColor Yellow
    }

    # Isolated stacks set EVOFLOW_GATEWAY_PORT (e.g. 8070); map to sidecar port scan.
    $preferredPort = 0
    if ($env:EVOFLOW_GATEWAY_PORT -and $env:EVOFLOW_GATEWAY_PORT.Trim()) {
        [void][int]::TryParse($env:EVOFLOW_GATEWAY_PORT.Trim(), [ref]$preferredPort)
    }
    if ($preferredPort -le 0 -and $GatewayPort -gt 0) {
        $preferredPort = $GatewayPort
    }
    if ($preferredPort -gt 0) {
        $env:EVOPANEL_BACKEND_PORT = [string]$preferredPort
        $env:EVOPANEL_BACKEND_PORT_MIN = [string]$preferredPort
        $env:EVOPANEL_BACKEND_PORT_MAX = [string]([Math]::Min(65535, $preferredPort + 40))
        Write-Host "    Sidecar port prefer=$preferredPort (range $($env:EVOPANEL_BACKEND_PORT_MIN)..$($env:EVOPANEL_BACKEND_PORT_MAX))" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "==> Starting frontend (tauri dev); sidecar starts inside the desktop process" -ForegroundColor Cyan
} else {
    if (-not $SkipBackend) {
        Write-Host ""
        Write-Host "==> Step 1/2: Starting Gateway (LangGraph in-process) [Web/External]" -ForegroundColor Cyan
        Start-EvoFlowBackend
    } else {
        Write-Host ""
        Write-Host "==> Step 1/2: Skip backend start (using existing Gateway)" -ForegroundColor Yellow
    }

    if (-not $SkipBackend) {
        $gateway = @{
            Url    = ("http://127.0.0.1:{0}" -f $script:DFGatewayPort)
            Source = ("started Gateway port ({0}, LangGraph in-process)" -f $script:DFGatewayPort)
        }
    } else {
        $gateway = Resolve-GatewayUrl
    }
    $gatewayUrl = $gateway.Url

    Write-Host ""
    Write-Host "==> Step 2/2: Starting frontend" -ForegroundColor Cyan
    Write-Host "    Gateway URL: $gatewayUrl" -ForegroundColor DarkYellow
    Write-Host "    Gateway source: $($gateway.Source)" -ForegroundColor DarkGray

    $gatewayWaitSec = 180
    $gatewayPollSec = 2
    $gatewayDeadline = (Get-Date).AddSeconds($gatewayWaitSec)
    while (-not (Test-GatewayHealthy -BaseUrl $gatewayUrl)) {
        if ((Get-Date) -ge $gatewayDeadline) {
            throw "Gateway is not reachable at $gatewayUrl after ${gatewayWaitSec}s. Please ensure backend gateway is healthy before starting frontend."
        }
        Start-Sleep -Seconds $gatewayPollSec
    }

    $env:EVOFLOW_GATEWAY_URL = $gatewayUrl
    $env:VITE_EVOFLOW_GATEWAY_URL = $gatewayUrl
    if ($script:DFBackendDir -and (Test-Path -LiteralPath $script:DFBackendDir)) {
        $env:EVOFLOW_BACKEND_DIR = $script:DFBackendDir
    }
    $venvPy = Join-Path $script:DFBackendDir ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPy) {
        $env:EVOPANEL_APP_SERVER_PYTHON = $venvPy
    }
    if (-not $WebOnly) {
        Write-Host "    Desktop transport: EXTERNAL Gateway + stdio mouthpiece (-ExternalGateway)" -ForegroundColor Yellow
    }
    try {
        $gwUri = [Uri]$gatewayUrl
        if ($gwUri.Port -gt 0) {
            $env:VITE_EVOFLOW_GATEWAY_PORT = [string]$gwUri.Port
        }
    } catch { }
}

if ($WebOnly) {
    $resolvedPort = Resolve-FrontendPort -PreferredPort $FrontendPort -AllowAutoFallback $AutoFrontendPort
    Write-Host "    Mode: Web only (vite)" -ForegroundColor Green
    Write-Host "    Frontend preferred port: $FrontendPort" -ForegroundColor DarkGray
    Write-Host "    Frontend selected port:  $resolvedPort" -ForegroundColor DarkGray
    Write-Host "    Frontend URL: http://localhost:$resolvedPort" -ForegroundColor Green
} else {
    Write-Host "    Mode: Tauri desktop (tauri dev)" -ForegroundColor Green
    $vitePortHint = if ($env:EVOFLOW_VITE_PORT -and $env:EVOFLOW_VITE_PORT.Trim()) { $env:EVOFLOW_VITE_PORT.Trim() } else { "1421" }
    Write-Host "    Vite port (EVOFLOW_VITE_PORT): $vitePortHint" -ForegroundColor DarkGray
    if ($env:EVOFLOW_TAURI_DEV_CONFIG -and $env:EVOFLOW_TAURI_DEV_CONFIG.Trim()) {
        Write-Host "    Tauri devUrl merge: $($env:EVOFLOW_TAURI_DEV_CONFIG.Trim()) (must match Vite port)" -ForegroundColor DarkGray
    } else {
        Write-Host "    Tauri devUrl: tauri.conf.json (default http://localhost:1421)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "==> Running frontend in current terminal (Ctrl+C to stop frontend)" -ForegroundColor Cyan
Set-Location -LiteralPath $EvoPanelDir

if (-not $WebOnly) {
    if (-not $env:EVOFLOW_VITE_HOST -or -not $env:EVOFLOW_VITE_HOST.Trim()) {
        $env:EVOFLOW_VITE_HOST = '0.0.0.0'
    }
}

if ($WebOnly) {
    $webHost = if ($env:EVOFLOW_VITE_HOST -and $env:EVOFLOW_VITE_HOST.Trim()) { $env:EVOFLOW_VITE_HOST.Trim() } else { '0.0.0.0' }
    npm run dev -- --host $webHost --port $resolvedPort --strictPort
} else {
    $tauriMerge = $env:EVOFLOW_TAURI_DEV_CONFIG
    if ($tauriMerge -and $tauriMerge.Trim()) {
        $cfgRel = $tauriMerge.Trim()
        $cfgPath = if ([System.IO.Path]::IsPathRooted($cfgRel)) { $cfgRel } else { Join-Path $EvoPanelDir $cfgRel }
        if (-not (Test-Path -LiteralPath $cfgPath)) {
            throw "EVOFLOW_TAURI_DEV_CONFIG points to missing file: $cfgPath"
        }
        Write-Host "    Tauri config merge: $cfgPath" -ForegroundColor DarkGray
        if (-not (Test-Path -LiteralPath $tauriCliJs)) {
            throw "Tauri CLI not found: $tauriCliJs. Run deps:ci in evopanel or dev-stack-isolated.bat -InstallEvoPanel"
        }
        & node $tauriCliJs dev --config $cfgPath
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } else {
        npm run tauri -- dev
    }
}
