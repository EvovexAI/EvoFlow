$path = "D:\dev\github\EvoFlow\evopanel\src-tauri\src\commands\browser_cdp.rs"
$content = [System.IO.File]::ReadAllLines($path)
for ($i = 0; $i -lt $content.Length; $i++) {
    $line = $content[$i]
    if ($line -match '^(pub fn |fn core_webview2|fn dispatch_on_webview|fn truncate)') {
        Write-Host "$($i+1): $line"
    }
}
