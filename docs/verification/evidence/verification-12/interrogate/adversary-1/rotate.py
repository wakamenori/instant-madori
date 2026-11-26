"""Rotate a scene about the Z axis by theta degrees (scene and sun together).

A rigid rotation keeps the analytic areas. Vertices are snapped onto the
receiving planes in f64 first, then rotated and rounded to f32, as the
exporter would produce for a room whose walls run at that angle.
"""
import math
import sys
from scene import Scene

src, dst, th = sys.argv[1], sys.argv[2], math.radians(float(sys.argv[3]))
s = Scene(src)
for vi, v in enumerate(s.vs):
    for f in s.faces:
        n, o = f[2], f[3]
        d = sum((v[k] - o[k]) * n[k] for k in range(3))
        if 0 < abs(d) < 1e-3:
            v = [v[k] - d * n[k] for k in range(3)]
    s.vs[vi] = v
c, sn = math.cos(th), math.sin(th)
R = lambda v: [c * v[0] - sn * v[1], sn * v[0] + c * v[1], v[2]]
s.vs = [R(v) for v in s.vs]
for f in s.faces:
    f[2] = R(f[2])
    f[3] = R(f[3])
for op in s.ops:
    for j in range(8):
        op[j] = R(op[j])
for sun in s.suns:
    sun[1] = R(sun[1])
s.write(dst)
for name, d, a in s.suns:
    print('expected', name, 'floor/wall/ceiling', a)
