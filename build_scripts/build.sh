#!/bin/sh

# Install dependencies from lockfile
npm ci

# Generate tilesources
npm run generate

# Build (sync-translations → add-biome-translations → check-translations → copy-flags → copy-locales → vite build)
npm run build

# Copy tilesources.json into dist for runtime access
cp src/data/tilesources.json dist/tilesources.json

# CF Pages output dir is "public" (shared with main/prod).
# Vite outputs to dist/, so swap it in for CF to pick up.
# Safe because CF builds run in a fresh clone.
rm -rf public
mv dist public
