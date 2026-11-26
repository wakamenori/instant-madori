#!/bin/bash
# usage: probe/sweep.sh SCENE FACE EXPECTED MODE -- rotate SCENE by 0..90 deg and print FACE's E area.
set -euo pipefail
cd "$(dirname "$0")/.."
S=docs/verification/evidence/verification-12/raw/scenes
for d in 0 5 10 15 20 25 30 35 40 45 50 55 60 65 70 75 80 85 90; do
  python3 probe/rotate.py "$S/$1.scene" probe/out/sweep.scene "$d" "$4"
  a=$(SUN_FACES=1 target/sunbench/release/sunbench probe/out/sweep.scene 3 0 0 1 2>&1 >/dev/null | awk -v f="$2" '$3==f {sub("area=","",$4); print $4}')
  python3 -c "e=$3; a=$a; err=a-e; print('deg=%2d %s area=%.6f err=%+.6f %s' % ($d, '$2', a, err, 'OUT' if abs(err)>0.01*e else 'ok'))"
done
