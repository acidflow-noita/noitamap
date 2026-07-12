$timestamp = [int](Get-Date -UFormat %s)
$filePath = "./public/currentVersion.txt"

# Write the timestamp as a single string, encoded in UTF-8 without BOM
$Utf8NoBomEncoding = New-Object System.Text.UTF8Encoding($False)
[System.IO.File]::WriteAllText($filePath, $timestamp.ToString(), $Utf8NoBomEncoding)

Write-Host "Added timestamp $timestamp to file: $filePath"

# Get the current directory name
$dirName = Split-Path -Path $PWD -Leaf

& wrangler pages deploy .\public\ --project-name $dirName
if ($LASTEXITCODE -ne 0) {
    throw "Wrangler deploy failed for $dirName with exit code $LASTEXITCODE"
}

Write-Host "Deploy command executed for directory: $dirName"
