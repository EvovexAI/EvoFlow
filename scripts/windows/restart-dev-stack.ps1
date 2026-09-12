# Start full EvoFlow dev stack (backend + frontend).
# Forcibly killing prior LangGraph/Gateway/EvoPanel processes is intentionally not done here;
# close old dev windows or free ports yourself if you hit "address already in use".

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
& (Join-Path $PSScriptRoot "start-dev-stack.ps1") @PSBoundParameters
