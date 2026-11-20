<#
.SYNOPSIS
  Stage BAAI/bge-small-zh-v1.5 weights for the desktop installer (~95MB).

.DESCRIPTION
  Copies from the local Hugging Face cache when present; otherwise downloads
  via huggingface_hub (hf-mirror friendly). Output lands under
  packaging/windows/local-embed-models/ for build-gateway-exe.ps1 to bundle
  into tools/local-embed/models/.
#>
param(
  [string]$ModelId = "BAAI/bge-small-zh-v1.5",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$BackendDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $ScriptDir "local-embed-models\BAAI\bge-small-zh-v1.5"
}
$OutAbs = [System.IO.Path]::GetFullPath($OutDir)
$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $VenvPython)) {
  $VenvPython = "python"
}

Write-Host "[local-embed] staging $ModelId -> $OutAbs"
if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = "https://hf-mirror.com" }

& $VenvPython (Join-Path $ScriptDir "prepare_local_embed_model.py") --model-id $ModelId --out-dir $OutAbs
if ($LASTEXITCODE -ne 0) {
  throw "[local-embed] prepare failed (exit=$LASTEXITCODE). Check network / HF_ENDPOINT=$($env:HF_ENDPOINT)"
}
Write-Host "[local-embed] OK"
