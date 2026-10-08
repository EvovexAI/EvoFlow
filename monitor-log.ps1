$log = "c:\Users\admin\.evoflow-dev\evoflow.stderr.log"
$lastLen = 0
while ($true) {
    $lines = [System.IO.File]::ReadAllLines($log)
    if ($lines.Count -gt $lastLen) {
        for ($i = $lastLen; $i -lt $lines.Count; $i++) {
            $ts = [DateTime]::Now.ToString("HH:mm:ss")
            Write-Host "$ts $($lines[$i])"
        }
        $lastLen = $lines.Count
    }
    Start-Sleep 2
}
