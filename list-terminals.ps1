Get-ChildItem 'C:\Users\admin\.cursor\projects\d-dev-github\terminals' -Filter '*.txt' | ForEach-Object {
    Write-Host $_.Name $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') $_.Length
}
