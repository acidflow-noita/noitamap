# Exit on error
$ErrorActionPreference = 'Stop'

# Define paths relative to the 'deploymentScripts' directory
$srcPath = '..\src'
$distPath = '..\public'  # Ensure this matches the output path in webpack.config.js
$tilesourcesFile = 'tilesources.json'
$mapDefinitionsScript = 'mapDefinitionsMaker.js'

# Change to the 'src' directory and run the Node.js script
Push-Location -Path $srcPath
node $mapDefinitionsScript
Pop-Location

# Copy the file from src to dist
Copy-Item -Path "$srcPath\$tilesourcesFile" -Destination "$distPath\$tilesourcesFile"

# Run webpack using npx
# Ensure we are in the project root directory (V:\noitamap) to find webpack.config.js
Push-Location -Path '..'
npx webpack
Pop-Location
