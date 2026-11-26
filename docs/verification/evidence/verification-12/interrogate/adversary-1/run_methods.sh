#!/usr/bin/env bash
# usage: run_methods.sh <scene>...   runs E, G10, A5 on each scene
set -eu
cd "$(dirname "$0")"
for sc in "$@"; do
  echo "== $sc"
  python3 dist.py "$sc"
  ../target/sunbench/release/sunbench "$sc" 3 0 0 1 | python3 areas.py
  ../target/sunbench/release/sunbench "$sc" 0 10 0 1 | python3 areas.py
  ../target/sunbench/release/sunbench "$sc" 1 5 0 1 | python3 areas.py
done
