"""Recompute per-condition medians and the slowest-condition median from raw/*.jsonl."""
import json
import statistics
from collections import defaultdict

raw = "docs/verification/evidence/verification-12/raw/"
for plat in ["macos", "wasm", "linux"]:
    rows = [json.loads(l) for l in open(raw + plat + ".jsonl")]
    g = defaultdict(list)
    prep = defaultdict(list)
    mem = defaultdict(int)
    reps = defaultdict(set)
    for r in rows:
        k = (r["method"], r["pitch"], r["n"])
        g[k + (r["sun"],)].append(r["ms"])
        if r["idx"] == 0:
            prep[k].append(r["prep"])
        mem[k] = max(mem[k], r["memory_bytes"])
        reps[k].add(r["rep"])
    for k in sorted({k[:3] for k in g}):
        meds = {s: statistics.median(v) for (m, p, n, s), v in g.items() if (m, p, n) == k}
        day = {s: v for s, v in meds.items() if s != "night"}
        slow = max(day, key=day.get)
        cnt = {s: len(v) for (m, p, n, s), v in g.items() if (m, p, n) == k}
        print(plat, k, "slowest", slow, "%.2f" % day[slow], "range %.2f-%.2f" % (min(g[k + (slow,)]), max(g[k + (slow,)])),
              "prep med %.3f" % statistics.median(prep[k]), "MiB %.1f" % (mem[k] / 2**20), "samples", sorted(set(cnt.values())))
