"""Replace each receiving face's plane (n, o) by the plane of its first f32 display triangle.

This is what an implementation that has only display data (no B-rep plane) would do.
"""
import math
import sys
from scene import Scene, f32

s = Scene(sys.argv[1])
for f in s.faces:
    a, b, c = ([f32(x) for x in s.vs[i]] for i in s.ts[f[4][0]][:3])
    u = [b[k] - a[k] for k in range(3)]
    v = [c[k] - a[k] for k in range(3)]
    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    L = math.sqrt(sum(x * x for x in n))
    n = [x / L for x in n]
    if sum(n[k] * f[2][k] for k in range(3)) < 0:
        n = [-x for x in n]
    f[2], f[3] = n, a
s.write(sys.argv[2])
for f in s.faces:
    print(f[0], 'own-triangle vertex distance max %.3g min %.3g' % (max(s.dist(f)), min(s.dist(f))))
