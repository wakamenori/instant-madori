#!/bin/bash
# usage: probe/shift.sh MODE -- translate slope.scene north by OY mm (no rotation) and print roof/3 (sloped ceiling).
set -euo pipefail
cd "$(dirname "$0")/.."
S=docs/verification/evidence/verification-12/raw/scenes
for oy in 0 100 250 333 500 1000 1234 2000 3000 4100 5000 7777; do
  python3 probe/rotate.py "$S/slope.scene" probe/out/shift.scene 0 "$1" 0 "$oy"
  a=$(SUN_FACES=1 target/sunbench/release/sunbench probe/out/shift.scene 3 0 0 1 2>&1 >/dev/null | awk '$3=="roof/3" {sub("area=","",$4); print $4}')
  python3 -c "e=1.086707; a=$a; print('oy=%5d sloped ceiling area=%.6f err=%+.6f %s' % ($oy, a, a-e, 'OUT' if abs(a-e)>0.01*e else 'ok'))"
done
