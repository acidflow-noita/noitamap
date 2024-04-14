$timestamp = [int](Get-Date -UFormat %s)
$filePath = "./public/currentVersion.txt"
Out-File -InputObject $timestamp -FilePath $filePath
Write-Host "Added timestamp $timestamp to file: $filePath"

$dirName = Split-Path -Path $PWD -Leaf
$deployCommand = "wrangler pages deploy .\public\ --project-name $dirName"
Invoke-Expression $deployCommand
Write-Host "Deploy command executed for directory: $dirName"
