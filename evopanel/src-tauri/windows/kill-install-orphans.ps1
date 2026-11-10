# Kill bash/python/node orphans that still touch this EvoFlow install dir.
# Used by installer-hooks.nsh (PREINSTALL / PREUNINSTALL) and safe to run manually:
#   powershell -NoProfile -ExecutionPolicy Bypass -File kill-install-orphans.ps1 -InstallDir 'D:\app\EvoFlow'
#
# Never blanket-kills python.exe — only processes whose ExecutablePath or CommandLine
# falls under -InstallDir (Agent bash background / extension runtimes).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = 'SilentlyContinue'

try {
    $inst = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
} catch {
    exit 0
}
if (-not $inst) { exit 0 }

$pfx = $inst + '\'
$filter = "Name='python.exe' OR Name='pythonw.exe' OR Name='bash.exe' OR Name='sh.exe' OR Name='node.exe'"

Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue | ForEach-Object {
    $kill = $false
    if ($_.ExecutablePath) {
        try {
            $full = [System.IO.Path]::GetFullPath($_.ExecutablePath)
            if ($full.Equals($inst, [StringComparison]::OrdinalIgnoreCase) -or
                $full.StartsWith($pfx, [StringComparison]::OrdinalIgnoreCase)) {
                $kill = $true
            }
        } catch {}
    }
    if (-not $kill -and $_.CommandLine -and
        $_.CommandLine.IndexOf($inst, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $kill = $true
    }
    if ($kill) {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
