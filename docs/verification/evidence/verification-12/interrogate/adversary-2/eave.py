"""Give slope.scene's mono-pitch roof a 600 mm eave on the high (south) side, as plan 3.2 does.

The roof underside stays one planar face (plan 3.2: 軒天 is one face parallel to the roof plane),
so the eave soffit outside the south wall is part of the receiving face roof/3.
The south wall's outer top edge is raised to meet the underside, as plan 3.1 extends walls.
"""
import math
import struct
import sys


def f32(x):
    return struct.unpack("f", struct.pack("f", x))[0]


src, dst = sys.argv[1], sys.argv[2]
eave = 600.0
k = math.tan(math.radians(30))
lines = open(src).read().split("\n")
nv = int(lines[0].split()[1])
V = [list(map(float, l.split())) for l in lines[1:1 + nv]]
first_glass = next(i for i, v in enumerate(V) if v[1] in (-98.0, -100.0))
for i, v in enumerate(V):
    if 24 <= i <= 47 and v[1] == 0.0:  # roof body, south end
        d = 200.0 + eave
        v[1] = -d
        v[2] = f32(v[2] + d * k)
    elif 48 <= i < first_glass and v[1] == -200.0 and v[2] == 4000.0:  # south wall outer top edge
        v[2] = f32(4000.0 + 200.0 * k)
for i, v in enumerate(V):
    lines[1 + i] = "%r %r %r" % tuple(v)
nt = int(lines[1 + nv])
fstart = 3 + nv + nt
nf = int(lines[fstart - 1])
for j in range(fstart, fstart + nf):
    p = lines[j].split()
    if p[0] == "roof/3":
        p[5:8] = ["0.0", "3000.0", "2267.9492"]  # a vertex on the underside that did not move
        lines[j] = " ".join(p)
open(dst, "w").write("\n".join(lines))
