# Remove oneMapCurrentVersionStamperAndUploader.ps1 files if present in each directory before upload
Get-ChildItem -Path . -Recurse -Filter "oneMapCurrentVersionStamperAndUploader.ps1" | ForEach-Object {
    Remove-Item -Force -Path $_.FullName
    Write-Host "Removed oneMapCurrentVersionStamperAndUploader.ps1 file at: $($_.FullName)"
}

Get-ChildItem -Directory | ForEach-Object {

    $timestamp = [int](Get-Date -UFormat %s)

    $filePath = "$($_.FullName)/public/currentVersion.txt"

    # Write the timestamp with UTF-8 encoding without BOM
    $Utf8NoBomEncoding = New-Object System.Text.UTF8Encoding($False)
    [System.IO.File]::WriteAllText($filePath, $timestamp.ToString(), $Utf8NoBomEncoding)

    Write-Host "Added timestamp $timestamp to file: $filePath"

    # Get the directory and project name for deployment
    $dirPath = $_.FullName
    $dirName = $_.Name

    Push-Location -Path $dirPath

    $deployCommand = "wrangler pages deploy .\public\ --project-name $dirName"
    Invoke-Expression $deployCommand

    Pop-Location

    Write-Host "Deploy command executed for directory: $dirName"

}

# Remove all .wrangler subdirectories after the deployment steps
Get-ChildItem -Path . -Recurse -Directory -Filter ".wrangler" | ForEach-Object {
    Remove-Item -Recurse -Force -Path $_.FullName
    Write-Host "Removed .wrangler directory at: $($_.FullName)"
}
