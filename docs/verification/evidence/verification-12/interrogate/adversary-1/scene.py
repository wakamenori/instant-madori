import struct


def f32(x):
    return struct.unpack('f', struct.pack('f', x))[0]


class Scene:
    def __init__(s, path):
        t = open(path).read().split()
        i = 1
        nv = int(t[i]); i += 1
        s.vs = [list(map(float, t[i + 3 * k:i + 3 * k + 3])) for k in range(nv)]; i += 3 * nv
        nt = int(t[i]); i += 1
        s.ts = [list(map(int, t[i + 4 * k:i + 4 * k + 4])) for k in range(nt)]; i += 4 * nt
        nf = int(t[i]); i += 1
        s.faces = []
        for _ in range(nf):
            k = int(t[i + 8])
            s.faces.append([t[i], int(t[i + 1]), list(map(float, t[i + 2:i + 5])),
                            list(map(float, t[i + 5:i + 8])), [int(x) for x in t[i + 9:i + 9 + k]]])
            i += 9 + k
        no = int(t[i]); i += 1
        s.ops = [[list(map(float, t[i + 24 * k + 3 * j:i + 24 * k + 3 * j + 3])) for j in range(8)] for k in range(no)]
        i += 24 * no
        ns = int(t[i]); i += 1
        s.suns = []
        for _ in range(ns):
            s.suns.append([t[i], list(map(float, t[i + 1:i + 4])), list(map(float, t[i + 4:i + 7]))])
            i += 7

    def write(s, path):
        o = ['SUN1', str(len(s.vs))] + [' '.join(repr(f32(c)) for c in v) for v in s.vs]
        o.append(str(len(s.ts)))
        o += [' '.join(map(str, t)) for t in s.ts]
        o.append(str(len(s.faces)))
        for f in s.faces:
            o.append(' '.join([f[0], str(f[1])] + [repr(x) for x in f[2] + f[3]] + [str(len(f[4]))] + list(map(str, f[4]))))
        o.append(str(len(s.ops)))
        for op in s.ops:
            o.append(' '.join(repr(c) for v in op for c in v))
        o.append(str(len(s.suns)))
        for n, d, a in s.suns:
            o.append(' '.join([n] + [repr(x) for x in d + a]))
        open(path, 'w').write('\n'.join(o) + '\n')

    def dist(s, f):
        n, o = f[2], f[3]
        return [sum((s.vs[v][k] - o[k]) * n[k] for k in range(3)) for ti in f[4] for v in s.ts[ti][:3]]
