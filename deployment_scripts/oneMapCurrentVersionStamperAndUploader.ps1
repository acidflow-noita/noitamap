$timestamp = [int](Get-Date -UFormat %s)
$filePath = "./public/currentVersion.txt"

# Write the timestamp as a single string, encoded in UTF-8 without BOM
$Utf8NoBomEncoding = New-Object System.Text.UTF8Encoding($False)
[System.IO.File]::WriteAllText($filePath, $timestamp.ToString(), $Utf8NoBomEncoding)

Write-Host "Added timestamp $timestamp to file: $filePath"

# Get the current directory name
$dirName = Split-Path -Path $PWD -Leaf

# Deploy command
$deployCommand = "wrangler pages deploy .\public\ --project-name $dirName"
Invoke-Expression $deployCommand

Write-Host "Deploy command executed for directory: $dirName"
