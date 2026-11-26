import json

rows = [json.loads(l) for l in open("docs/verification/evidence/verification-12/raw/dev.jsonl")]
B = [r for r in rows if r["method"] == "B"]
print("B rows", len(B), "rays", sum(r["rays"] for r in B), "diff", sum(r["different_points"] or 0 for r in B))
print({r["profile"] for r in rows}, {r["os"] for r in rows})
for r in rows:
    if r["method"] == "E-convex":
        print(r["case"], r["sun"], [None if e is None else round(e, 7) for e in r["errors"]], [round(a, 6) for a in r["areas"]])
