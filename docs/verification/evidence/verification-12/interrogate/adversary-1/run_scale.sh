#!/usr/bin/env bash
# usage: run_scale.sh <scene> <c>...
set -eu
cd "$(dirname "$0")"
scene=$1; shift
for c in "$@"; do
  out="scale_${c}.scene"
  echo "== c=$c"
  python3 scale.py "$scene" "$out" "$c"
  python3 dist.py "$out" | awk '$1 ~ /roof\/3/'
  ../target/sunbench/release/sunbench "$out" 3 0 0 1 | python3 areas.py
  ../target/sunbench/release/sunbench "$out" 0 10 0 1 | python3 areas.py
done
