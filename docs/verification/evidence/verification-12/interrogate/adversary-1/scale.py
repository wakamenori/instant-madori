"""Scale a scene vertically by c (z' = c z) and re-round vertices to f32.

An affine map sends planes to planes and commutes with parallel projection when
the sun direction is mapped too, so the exact lit region maps onto the new
exact lit region. On a plane with unit normal n the area scales by
c * |(nx, ny, nz / c)|. Vertices are first snapped onto the receiving planes in
f64 so the f32 error is that of the new exact coordinates.
For the slope scene this changes the roof pitch from 30 deg to atan(c tan 30).
"""
import math
import sys
from scene import Scene

src, dst, c = sys.argv[1], sys.argv[2], float(sys.argv[3])
s = Scene(src)
for vi, v in enumerate(s.vs):
    for f in s.faces:
        n, o = f[2], f[3]
        d = sum((v[k] - o[k]) * n[k] for k in range(3))
        if 0 < abs(d) < 1e-3:
            v = [v[k] - d * n[k] for k in range(3)]
    s.vs[vi] = v
s.vs = [[v[0], v[1], v[2] * c] for v in s.vs]
factor = {}
for f in s.faces:
    n = f[2]
    m = [n[0], n[1], n[2] / c]
    L = math.sqrt(sum(x * x for x in m))
    f[2] = [x / L for x in m]
    f[3] = [f[3][0], f[3][1], f[3][2] * c]
    factor[f[0]] = c * L
for op in s.ops:
    for j in range(8):
        op[j] = [op[j][0], op[j][1], op[j][2] * c]
for sun in s.suns:
    d = sun[1]
    m = [d[0], d[1], d[2] * c]
    L = math.sqrt(sum(x * x for x in m))
    sun[1] = [x / L for x in m]
s.write(dst)
print('pitch deg', math.degrees(math.atan(c * math.tan(math.radians(30)))))
print('area factors', factor)
for name, d, a in Scene(src).suns:
    print('expected', name, 'wall(north)', a[1] * factor.get('north000/3', 0), 'ceiling', a[2] * factor.get('roof/3', 0))
