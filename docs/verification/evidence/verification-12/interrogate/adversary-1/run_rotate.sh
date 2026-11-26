#!/usr/bin/env bash
# usage: run_rotate.sh <scene> <deg>...
set -eu
cd "$(dirname "$0")"
scene=$1; shift
for th in "$@"; do
  out="rot_$(basename "$scene" .scene)_${th}.scene"
  echo "== theta=$th"
  python3 rotate.py "$scene" "$out" "$th"
  ../target/sunbench/release/sunbench "$out" 3 0 0 1 | python3 areas.py
done
