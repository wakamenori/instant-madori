#!/usr/bin/env bash
# usage: run_rot_meshplane.sh <scene> <deg>...  rotate, derive planes from the mesh, run E and G10
set -eu
cd "$(dirname "$0")"
scene=$1; shift
for th in "$@"; do
  out="rotmp_$(basename "$scene" .scene)_${th}.scene"
  python3 rotate.py "$scene" tmp_rot.scene "$th" > /dev/null
  echo "== theta=$th"
  python3 meshplane.py tmp_rot.scene "$out" | awk '$1 ~ /roof\/3|north/'
  ../target/sunbench/release/sunbench "$out" 3 0 0 1 | python3 areas.py
  ../target/sunbench/release/sunbench "$out" 0 10 0 1 | python3 areas.py
done
