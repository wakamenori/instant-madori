import sys
from scene import Scene

s = Scene(sys.argv[1])
for f in s.faces:
    ds = s.dist(f)
    print(f[0], f[1], 'max', max(ds), 'min', min(ds))
