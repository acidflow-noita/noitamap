Get-ChildItem -Directory | ForEach-Object {
    $timestamp = [int](Get-Date -UFormat %s)
    $filePath = "$($_.FullName)/public/currentVersion.txt"
    Out-File -InputObject $timestamp -FilePath $filePath
    Write-Host "Added timestamp $timestamp to file: $filePath"
    
    $dirPath = $_.FullName
    $dirName = $_.Name
    Push-Location -Path $dirPath
    $deployCommand = "wrangler pages deploy .\public\ --project-name $dirName"
    Invoke-Expression $deployCommand
    Pop-Location
    Write-Host "Deploy command executed for directory: $dirName"
}
