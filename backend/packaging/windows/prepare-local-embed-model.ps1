<#
.SYNOPSIS
  Stage BAAI/bge-small-zh-v1.5 weights for the desktop installer (~95MB).

.DESCRIPTION
  Uses tree already under packaging/windows/local-embed-models/ when present
  (preferred for CI: commit safetensors + tokenizer). Otherwise downloads via
  huggingface_hub. On GitHub Actions does NOT force hf-mirror (official hub
  first); local/CN defaults still prefer HF_ENDPOINT=https://hf-mirror.com.
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

# Local/CN convenience only — CI must reach huggingface.co without a forced mirror.
$inCi = [bool]($env:GITHUB_ACTIONS -or ($env:CI -eq "true") -or ($env:CI -eq "1"))
if (-not $inCi -and -not $env:HF_ENDPOINT) {
  $env:HF_ENDPOINT = "https://hf-mirror.com"
}

# Ensure hub client exists before download path runs.
& $VenvPython -c "import huggingface_hub" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[local-embed] installing huggingface_hub..."
  & $VenvPython -m pip install -q "huggingface_hub>=0.23"
  if ($LASTEXITCODE -ne 0) {
    throw "[local-embed] pip install huggingface_hub failed (exit=$LASTEXITCODE)"
  }
}

& $VenvPython (Join-Path $ScriptDir "prepare_local_embed_model.py") --model-id $ModelId --out-dir $OutAbs
if ($LASTEXITCODE -ne 0) {
  throw "[local-embed] prepare failed (exit=$LASTEXITCODE). Check network / HF_ENDPOINT=$($env:HF_ENDPOINT)"
}
Write-Host "[local-embed] OK"
