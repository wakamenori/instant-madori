#!/usr/bin/env bash
# usage: run_addtris.sh <N>...   adds N underground triangles to house.scene and runs E once
set -eu
cd "$(dirname "$0")"
house=../docs/verification/evidence/verification-12/raw/scenes/house.scene
for n in "$@"; do
  out="house_plus_${n}.scene"
  python3 addtris.py "$house" "$out" "$n"
  ../target/sunbench/release/sunbench "$out" 3 0 0 3 | python3 -c '
import json, sys
for l in sys.stdin:
    r = json.loads(l)
    if r["sun"] in ("Dec15", "Mar12"):
        c = r["counts"]
        print(r["rep"], r["sun"], "opaque", r["opaque"], "ms %.2f" % r["ms"], "candidates", c[3], "cuts", c[4], "peak", c[7], "areas", [round(a, 6) for a in r["areas"]])
'
done
