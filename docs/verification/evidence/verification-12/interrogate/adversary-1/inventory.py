import glob
import math
from scene import Scene

for p in sorted(glob.glob('../docs/verification/evidence/verification-12/raw/scenes/*.scene')):
    s = Scene(p)
    glass = sum(1 for t in s.ts if t[3] != 0)
    roles = {}
    for f in s.faces:
        roles.setdefault(f[1], []).append(f[0])
    nonaxis = [f[0] for f in s.faces if max(abs(x) for x in f[2]) < 0.999999]
    suns = [(n, round(math.degrees(math.asin(d[2])), 2)) for n, d, a in s.suns]
    print(p.split('/')[-1], 'tris', len(s.ts), 'glass', glass, 'faces', len(s.faces),
          'roles', {k: len(v) for k, v in roles.items()}, 'non-axis faces', nonaxis, 'sun alt', suns)
