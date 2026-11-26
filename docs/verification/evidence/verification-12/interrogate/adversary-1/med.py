import json
import statistics
import sys
from collections import defaultdict

raw = '../docs/verification/evidence/verification-12/raw/'
for plat in ['macos', 'wasm', 'linux']:
    rows = [json.loads(l) for l in open(raw + plat + '.jsonl')]
    g = defaultdict(list)
    mem = defaultdict(set)
    for r in rows:
        k = (r['method'], r['pitch'], r['n'])
        g[k + (r['sun'],)].append(r)
        mem[k].add(r['memory_bytes'])
    keys = sorted({k[:3] for k in g})
    for k in keys:
        per = {}
        for kk, rs in g.items():
            if kk[:3] != k:
                continue
            ms = [r['ms'] for r in rs]
            per[kk[3]] = (statistics.median(ms), min(ms), max(ms), len(ms), rs[0]['areas'], rs[0]['counts'][3])
        day = {s: v for s, v in per.items() if v[4] is not None}
        worst = max(per.items(), key=lambda kv: kv[1][0])
        print(plat, k, 'worst', worst[0], 'median %.2f range %.2f-%.2f n=%d cand=%d' % (worst[1][0], worst[1][1], worst[1][2], worst[1][3], worst[1][5]),
              'mem MiB', sorted(round(m / 2**20, 1) for m in mem[k]))
    if len(sys.argv) > 1:
        for kk, rs in sorted(g.items()):
            print(plat, kk, [round(r['ms'], 3) for r in rs], rs[0]['areas'])
