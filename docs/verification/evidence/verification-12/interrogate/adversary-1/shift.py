"""Translate a scene rigidly by (dx, dy, dz) and re-round vertices to f32.

Vertices lying within 1e-3 mm of a receiving face plane are first snapped onto
that plane in f64, so the f32 rounding error is that of the shifted exact
coordinates, as the exporter would produce for a house placed there.
Analytic values are unchanged by a rigid translation.
"""
import sys
from scene import Scene

src, dst, dx, dy, dz = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:6])
s = Scene(src)
for f in s.faces:
    n, o = f[2], f[3]
    for ti in f[4]:
        for vi in s.ts[ti][:3]:
            v = s.vs[vi]
            d = sum((v[k] - o[k]) * n[k] for k in range(3))
            if abs(d) < 1e-3:
                s.vs[vi] = [v[k] - d * n[k] for k in range(3)]
# snap every other vertex that lies near any receiving plane too (shared vertices)
for vi, v in enumerate(s.vs):
    for f in s.faces:
        n, o = f[2], f[3]
        d = sum((v[k] - o[k]) * n[k] for k in range(3))
        if 0 < abs(d) < 1e-3:
            v = [v[k] - d * n[k] for k in range(3)]
    s.vs[vi] = v
t = [dx, dy, dz]
s.vs = [[v[k] + t[k] for k in range(3)] for v in s.vs]
for f in s.faces:
    f[3] = [f[3][k] + t[k] for k in range(3)]
for op in s.ops:
    for j in range(8):
        op[j] = [op[j][k] + t[k] for k in range(3)]
s.write(dst)
