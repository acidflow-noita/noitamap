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
