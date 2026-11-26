// Run in the prototype page (crates/viewer/proto/index.html?pkg=all) after it reports ready:
//   await (await import("/docs/verification/evidence/verification-10/probes.js")).run()
// Returns the values that verification-10.md quotes for pixels, decoding and mipmaps.
const view = () => document.querySelector("#view");

function grab() {
  const v = view();
  const c = new OffscreenCanvas(v.width, v.height);
  const g = c.getContext("2d");
  g.drawImage(v, 0, 0);
  return g.getImageData(0, 0, v.width, v.height);
}

// Read the canvas in the same task as the draw: a WebGPU canvas is empty after compositing.
async function shot(options) {
  const s = window.__proto;
  await s.renderScene(options);
  if (s.error) throw new Error(s.error);
  return grab();
}

function compare(a, b, threshold) {
  const bands = Array(Math.ceil(a.width / 100)).fill(0);
  let changed = 0,
    exact = 0,
    sq = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      let d = 0;
      for (let k = 0; k < 3; k++) {
        const e = a.data[i + k] - b.data[i + k];
        d += Math.abs(e);
        sq += (e / 255) ** 2;
      }
      if (d > 0) exact++;
      if (d > threshold) {
        changed++;
        bands[Math.floor(x / 100)]++;
      }
    }
  return { changed, exact, total: a.width * a.height, bands, rmse: Math.sqrt(sq / (a.width * a.height * 3)) };
}

function mean(img, cx, cy, r) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      const i = (y * img.width + x) * 4;
      for (let k = 0; k < 3; k++) sum[k] += img.data[i + k];
      n++;
    }
  return sum.map((v) => Math.round(v / n));
}

async function decode() {
  const c = new OffscreenCanvas(1024, 1024);
  const g = c.getContext("2d");
  for (let y = 0; y < 1024; y += 8)
    for (let x = 0; x < 1024; x += 8) {
      g.fillStyle = `rgb(${(x * 7 + y * 3) % 256},${((x * 5) ^ (y * 11)) % 256},${(x + y) % 256})`;
      g.fillRect(x, y, 8, 8);
    }
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  const ms = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const o = new OffscreenCanvas(bitmap.width, bitmap.height);
    const og = o.getContext("2d", { willReadFrequently: true });
    og.drawImage(bitmap, 0, 0);
    const data = og.getImageData(0, 0, bitmap.width, bitmap.height);
    ms.push(performance.now() - t0);
    bitmap.close();
    if (data.data.length !== 1024 * 1024 * 4) throw new Error("decoded size");
  }
  const warm = ms.slice(1).sort((a, b) => a - b);
  return { jpegBytes: blob.size, firstMs: ms[0], warmMedianMs: warm[2], warmRangeMs: [warm[0], warm[4]], allMs: ms };
}

export async function run() {
  const s = window.__proto;
  const T = 6;
  const out = { threshold: "a pixel changed when the summed |dR|+|dG|+|dB| exceeds 6 (of 765)" };
  const b = { mode: "b-planar", glass: false, grid: 1, mips: "gpu", sampling: "grad", anisotropy: 16 };

  const south = { ...b, camera: "south", anchor: "world" };
  out.stretchSouthWorld3640vs5460 = compare(await shot({ ...south, length: 3640 }), await shot({ ...south, length: 5460 }), T);

  const nw = { ...b, camera: "north-west" };
  out.stretchNorthWestWorld3640vs3790 = compare(
    await shot({ ...nw, anchor: "world", length: 3640 }),
    await shot({ ...nw, anchor: "world", length: 3790 }),
    T,
  );
  out.stretchNorthWestStart3640vs3790 = compare(
    await shot({ ...nw, anchor: "start", length: 3640 }),
    await shot({ ...nw, anchor: "start", length: 3790 }),
    T,
  );

  const col = { ...b, camera: "column east", anchor: "world", length: 3640 };
  out.columnPlanarVsTriplanar = compare(await shot(col), await shot({ ...col, mode: "b-triplanar-column" }), T);

  const a = { mode: "planar", camera: "north window", glass: false, grid: 1, mips: "cpu", anisotropy: 16, anchor: "world", length: 3640 };
  out.aPlanarVsVertexUv = compare(await shot(a), await shot({ ...a, mode: "vertex-uv" }), T);

  const through = { camera: "through window", grid: 1, length: 3640, anchor: "world", anisotropy: 16, sampling: "grad" };
  out.floorThroughWindowMean5x5 = {};
  for (const [label, o] of [
    ["A planar", { mode: "planar", mips: "cpu" }],
    ["B planar", { mode: "b-planar", mips: "gpu" }],
  ])
    out.floorThroughWindowMean5x5[label] = {
      glassOff: mean(await shot({ ...through, ...o, glass: false }), 600, 375, 2),
      glassOn: mean(await shot({ ...through, ...o, glass: true }), 600, 375, 2),
    };

  out.decode1024Jpeg = await decode();
  out.cpuMipMedianMs = s.mipMedianMs;
  out.gpuMip = await s.probe();
  out.userAgent = navigator.userAgent;
  return out;
}
