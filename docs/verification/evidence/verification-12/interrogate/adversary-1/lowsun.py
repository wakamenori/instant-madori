"""Floor scene with south suns at low altitudes; floor should stay dark (room depth 3.5 m)."""
import math
import sys
from scene import Scene

s = Scene('../docs/verification/evidence/verification-12/raw/scenes/' + sys.argv[1])
alts = [float(a) for a in sys.argv[3:]]
s.suns = []
for a in alts:
    r = math.radians(a)
    s.suns.append(['alt%g' % a, [0.0, -math.cos(r), math.sin(r)], [-1.0, -1.0, -1.0]])
s.write(sys.argv[2])
