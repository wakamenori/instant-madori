import json
import sys

for line in sys.stdin:
    r = json.loads(line)
    print(r['method'], r['sun'], 'floor/wall/ceiling m2 =', [round(a, 6) for a in r['areas']])
