"""Append N opaque triangles under the ground (z = -3000 .. -3100) beneath the house.

None of them can shadow a receiving face, so the shadow-candidate count, cut
count and peak piece count stay the same; only the number of opaque triangles
grows.
"""
import sys
from scene import Scene

src, dst, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
s = Scene(src)
base = len(s.vs)
side = int(n ** 0.5) + 2
for i in range(side):
    for j in range(side):
        s.vs.append([i * 10000.0 / side, j * 8000.0 / side, -3000.0 - (i + j) % 7])
k = 0
for i in range(side - 1):
    for j in range(side - 1):
        if k >= n:
            break
        a = base + i * side + j
        s.ts.append([a, a + 1, a + side, 0])
        k += 1
s.write(dst)
print('added', k, 'triangles; total', len(s.ts))
