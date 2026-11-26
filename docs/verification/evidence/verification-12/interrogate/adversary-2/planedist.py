"""Print, per receiving face, how far its own f32 triangles stray from the face plane (mm)."""
import sys

t = open(sys.argv[1]).read().split()
i = 1
nv = int(t[i]); i += 1
V = [tuple(map(float, t[i + 3 * k:i + 3 * k + 3])) for k in range(nv)]; i += 3 * nv
nt = int(t[i]); i += 1
T = [tuple(map(int, t[i + 4 * k:i + 4 * k + 3])) for k in range(nt)]; i += 4 * nt
nf = int(t[i]); i += 1
for _ in range(nf):
    fid, role = t[i], t[i + 1]
    n = list(map(float, t[i + 2:i + 5])); o = list(map(float, t[i + 5:i + 8]))
    k = int(t[i + 8]); ids = list(map(int, t[i + 9:i + 9 + k])); i += 9 + k
    d = [sum((V[j][q] - o[q]) * n[q] for q in range(3)) for tid in ids for j in T[tid]]
    print(f"{fid} role={role} own-vertex distance to plane: min {min(d):+.2e} max {max(d):+.2e} mm")
