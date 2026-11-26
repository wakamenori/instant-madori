"""Slope scene with a 45 deg south sun, with and without the 'roof/1' receiving face."""
import math
from scene import Scene

src = '../docs/verification/evidence/verification-12/raw/scenes/slope.scene'
for drop in (False, True):
    s = Scene(src)
    a = math.radians(45)
    s.suns = [['S45', [0.0, -math.cos(a), math.sin(a)], [-1.0, -1.0, -1.0]]]
    if drop:
        s.faces = [f for f in s.faces if f[0] != 'roof/1']
    s.write('slope_s45_%s.scene' % ('without_roof1' if drop else 'as_exported'))
s = Scene(src)
for f in s.faces:
    if f[0].startswith('roof'):
        zs = sorted({s.vs[v][2] for t in f[4] for v in s.ts[t][:3]})
        print(f[0], 'role', f[1], 'normal', f[2], 'z of its vertices', zs)
