#!/bin/sh
# Bundle the 3D frontend (three.js tree-shaken + minified) into js/three/bb3d.min.js
set -e
cd "$(dirname "$0")/.."
npx esbuild three-src/app.js --bundle --minify --format=iife --target=es2019 --legal-comments=none --outfile=js/three/bb3d.min.js "$@"
