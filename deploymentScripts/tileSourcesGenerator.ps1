# Exit on error
$ErrorActionPreference = 'Stop'

# Define paths relative to the 'deploymentScripts' directory
$srcPath = '..\public\js'
$distPath = '..\public'  
$tilesourcesFile = 'tilesources.json'
$mapDefinitionsScript = 'mapDefinitionsMaker.js'

# Change to the 'src' directory and run the Node.js script
Push-Location -Path $srcPath
node $mapDefinitionsScript
Pop-Location

Push-Location -Path '..'
Pop-Location
