// The corrected plan 4.8 rule: u = t x n (right when facing the face), v = -t (image rows run down).
// An image reads unmirrored from the front when (u x v) . n < 0, and upright when v points down the face.
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const neg = (a) => a.map((x) => -x);
const s = Math.SQRT1_2;
const faces = [
  ["wall n=+y", [0, 1, 0], [0, 0, 1]],
  ["wall n=-y", [0, -1, 0], [0, 0, 1]],
  ["wall n=+x", [1, 0, 0], [0, 0, 1]],
  ["wall n=-x", [-1, 0, 0], [0, 0, 1]],
  ["wall diagonal", [s, s, 0], [0, 0, 1]],
  ["floor top n=+z", [0, 0, 1], [0, 1, 0]],
  ["ceiling n=-z", [0, 0, -1], [0, 1, 0]],
];
for (const [name, n, t] of faces) {
  const u = cross(t, n), v = neg(t);
  const mirrored = dot(cross(u, v), n) >= 0;
  const upright = name.startsWith("wall") ? v[2] < 0 : "n/a";
  console.log(`${name.padEnd(16)} t=${JSON.stringify(t)} u=${JSON.stringify(u.map((x) => +x.toFixed(4)))} v=${JSON.stringify(v)} -> ${mirrored ? "MIRRORED" : "reads correctly"}, upright: ${upright}`);
}
