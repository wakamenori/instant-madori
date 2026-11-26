#!/bin/bash
# usage: probe/run.sh DEG MODE [OX OY]  -- runs method E on every rotated scene and prints areas.
set -euo pipefail
cd "$(dirname "$0")/.."
B=target/sunbench/release/sunbench
S=docs/verification/evidence/verification-12/raw/scenes
mkdir -p probe/out
for s in floor wall slope slit gap50 gap20 house; do
  python3 probe/rotate.py "$S/$s.scene" "probe/out/$s.scene" "$@"
  echo "== $s (deg=$1 mode=${2:-f64plane} offset=${3:-0},${4:-0})"
  "$B" "probe/out/$s.scene" 3 0 0 1 | python3 -c '
import json,sys
for l in sys.stdin:
  r=json.loads(l); print(r["sun"],[round(a,6) for a in r["areas"]], "ms=%.3f"%r["ms"])'
done
