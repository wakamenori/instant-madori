"""Drop the neighbour boxes (every triangle entirely south of the house, y < -1000) from house.scene."""
from scene import Scene

s = Scene('../docs/verification/evidence/verification-12/raw/scenes/house.scene')
ys = sorted({v[1] for v in s.vs})
print('y values min..max', ys[0], ys[-1], 'count', len(ys))
before = len(s.ts)
s.ts = [t for t in s.ts if max(s.vs[i][1] for i in t[:3]) >= -1000]
print('triangles', before, '->', len(s.ts))
# triangle indices in faces refer to the old list; rebuild mapping
old = Scene('../docs/verification/evidence/verification-12/raw/scenes/house.scene')
keep = [i for i, t in enumerate(old.ts) if max(old.vs[j][1] for j in t[:3]) >= -1000]
remap = {o: n for n, o in enumerate(keep)}
for f in s.faces:
    f[4] = [remap[i] for i in f[4]]
s.write('house_noneighbors.scene')
