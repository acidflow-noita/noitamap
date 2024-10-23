#!/bin/sh



# build without altering package.lock
# https://docs.github.com/en/actions/use-cases-and-examples/building-and-testing/building-and-testing-nodejs
npm ci

# Generate tilesources
npm run generate

# Check if git is dirty, if it is, fail
# if ! git diff --quiet; then
#     git status
#     printf "\n%s\n\n" "Build generated differences; commit the result then try again"
#     exit 1
# fi

# Generate JS from TS
npm run build

# Copy the built tilesources.json into the dist which is /public
cp "../src/data/tilesources.json" "../public/js/tilesources.json"
