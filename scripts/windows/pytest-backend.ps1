# Run backend pytest via `python -m pytest` to avoid uv on Windows failing with:
#   Failed to canonicalize script path
# when using `uv run pytest` (console script shim).
$ErrorActionPreference = "Stop"
$Backend = (Resolve-Path (Join-Path $PSScriptRoot "..\..\backend")).Path
Set-Location -LiteralPath $Backend
& uv run python -m pytest @args
