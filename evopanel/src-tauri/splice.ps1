$src = "D:\dev\github\EvoFlow\evopanel\src-tauri\src\commands\browser_cdp.rs"
$all = [System.IO.File]::ReadAllLines($src)
$before = $all[0..157]
$after = $all[474..($all.Length-1)]
$newFn = [System.IO.File]::ReadAllLines("D:\dev\github\EvoFlow\evopanel\src-tauri\src\commands\browser_cdp_call_cdp_NEW.rs")
$combined = @()
$combined += $before
$combined += $newFn
$combined += $after
[System.IO.File]::WriteAllLines($src, $combined)
Write-Host "Written $($combined.Count) lines (was $($all.Length))"
