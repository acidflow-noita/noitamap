#!/bin/bash

HERE=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

# Install dependencies from lockfile
# https://docs.github.com/en/actions/use-cases-and-examples/building-and-testing/building-and-testing-nodejs
npm ci

# Generate tilesources
npm run generate

# Build: add-biome-translations → copy-flags → copy-locales → vite build
# (flags and locales must be in public/ before vite copies public/ → dist/)
npm run build

# Copy tilesources.json into dist for runtime access
cp "$HERE/../src/data/tilesources.json" "$HERE/../dist/tilesources.json"
