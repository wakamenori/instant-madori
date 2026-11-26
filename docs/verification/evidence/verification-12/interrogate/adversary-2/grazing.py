"""Replace a scene's suns with altitude ALT and azimuths (deg from south, + = toward east) and run E.

usage: grazing.py SCENE ALT AZ...
Prints per-face areas from the standalone crate (needs SUN_FACES support in lib.rs).
"""
import math
import os
import subprocess
import sys

scene, alt = sys.argv[1], float(sys.argv[2])
azs = [float(a) for a in sys.argv[3:]]
t = open(scene).read().split("\n")
while t and t[-1] == "":
    t.pop()
ns = int(t[-2]) if False else None
# Last block: count line then one line per sun.
idx = len(t) - 1
while len(t[idx].split()) != 1:
    idx -= 1
lines = t[:idx]
a = math.radians(alt)
lines.append(str(len(azs)))
for az in azs:
    b = math.radians(az)
    s = (math.cos(a) * math.sin(b), -math.cos(a) * math.cos(b), math.sin(a))
    lines.append("az%s %r %r %r -1 -1 -1" % (az, *s))
out = os.path.join(os.path.dirname(__file__), "out", "grazing.scene")
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "w").write("\n".join(lines) + "\n")
root = os.path.join(os.path.dirname(__file__), "..")
r = subprocess.run(
    [os.path.join(root, "target/sunbench/release/sunbench"), out, "3", "0", "0", "1"],
    capture_output=True, text=True, env=dict(os.environ, SUN_FACES="1"), check=True,
)
for line in r.stderr.splitlines():
    if line.startswith("face"):
        print(line)
