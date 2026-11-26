#!/usr/bin/env bash
# usage: run_shift.sh <scene> <dx> <dy> <dz>...
set -eu
cd "$(dirname "$0")"
scene=$1; dx=$2; dy=$3; shift 3
for dz in "$@"; do
  out="shift_${dx}_${dy}_${dz}.scene"
  python3 shift.py "$scene" "$out" "$dx" "$dy" "$dz"
  echo "== shift ($dx, $dy, $dz)"
  python3 dist.py "$out" | awk '$1 ~ /roof/'
  ../target/sunbench/release/sunbench "$out" 3 0 0 1 | python3 areas.py
done
