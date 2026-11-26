"""Rigidly move a SUN1 scene in the XY plane, rounding vertices to f32 like display data.

usage: rotate.py SRC DST DEG [f64plane|meshplane] [OX OY]
f64plane: rotate the scene's own f64 plane (n, o) exactly (favourable to the prototype).
meshplane: derive (n, o) from the face's first f32 triangle, as a reader of display data must.
"""
import math
import struct
import sys


def f32(x):
    return struct.unpack("f", struct.pack("f", x))[0]


src, dst, deg = sys.argv[1], sys.argv[2], float(sys.argv[3])
mode = sys.argv[4] if len(sys.argv) > 4 else "f64plane"
ox = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
oy = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
t = open(src).read().split()
i = 0


def tok():
    global i
    i += 1
    return t[i - 1]


c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))


def rot(x, y, z, translate=True):
    X, Y = c * x - s * y, s * x + c * y
    if translate:
        X += ox
        Y += oy
    return X, Y, z


out = []
assert tok() == "SUN1"
nv = int(tok())
out.append(f"SUN1 {nv}")
V = []
for _ in range(nv):
    x, y, z = float(tok()), float(tok()), float(tok())
    v = tuple(f32(q) for q in rot(x, y, z))
    V.append(v)
    out.append("%r %r %r" % v)
nt = int(tok())
out.append(str(nt))
T = []
for _ in range(nt):
    a, b, cc, g = tok(), tok(), tok(), tok()
    T.append((int(a), int(b), int(cc)))
    out.append(f"{a} {b} {cc} {g}")
nf = int(tok())
out.append(str(nf))
for _ in range(nf):
    fid = tok()
    role = tok()
    n = [float(tok()) for _ in range(3)]
    o = [float(tok()) for _ in range(3)]
    k = int(tok())
    ids = [tok() for _ in range(k)]
    n = rot(*n, translate=False)
    o = rot(*o)
    if mode == "meshplane":
        a, b, cc = [V[j] for j in T[int(ids[0])]]
        u = [b[q] - a[q] for q in range(3)]
        w = [cc[q] - a[q] for q in range(3)]
        cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
        L = math.sqrt(sum(x * x for x in cr))
        n = [x / L for x in cr]
        o = a
    out.append(" ".join([fid, role] + [repr(x) for x in n] + [repr(x) for x in o] + [str(k)] + ids))
no = int(tok())
out.append(str(no))
for _ in range(no * 8):
    x, y, z = float(tok()), float(tok()), float(tok())
    out.append("%r %r %r" % rot(x, y, z))
ns = int(tok())
out.append(str(ns))
for _ in range(ns):
    name = tok()
    sv = [float(tok()) for _ in range(3)]
    ex = [tok() for _ in range(3)]
    out.append(" ".join([name] + [repr(x) for x in rot(*sv, translate=False)] + ex))
assert i == len(t), (i, len(t))
open(dst, "w").write("\n".join(out) + "\n")
