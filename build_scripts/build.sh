#!/bin/bash

HERE=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

# Install dependencies from lockfile
# https://docs.github.com/en/actions/use-cases-and-examples/building-and-testing/building-and-testing-nodejs
npm ci

# Generate tilesources
npm run generate

# Build (vite outputs to dist/)
npm run build

# Copy tilesources.json into dist for runtime access
cp "$HERE/../src/data/tilesources.json" "$HERE/../dist/tilesources.json"

# CF Pages output dir is set to "public" (shared with main/prod).
# Vite outputs to dist/, so move it to public/ for CF to pick up.
# This is safe because CF builds run in a fresh clone.
rm -rf "$HERE/../public"
mv "$HERE/../dist" "$HERE/../public"
