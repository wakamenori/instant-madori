import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { crateFamilies, rustBoundaries, viewerWasmBoundary } from "./boundaries.ts";
import { inspectViewerWasm } from "./check-viewer-wasm.ts";
type FixtureFunction = { name?: string; bodySize: number; exportAs?: string | readonly string[] };
type Fixture = {
  importedFunctions?: readonly string[];
  functions: readonly FixtureFunction[];
  bindgenIdentifiers?: readonly string[];
  names?: boolean;
};

function leb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    out.push(rest === 0 ? byte : byte | 0x80);
  } while (rest !== 0);
  return out;
}

const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
};
const vector = (items: number[][]) => [...leb(items.length), ...items.flat()];
const section = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload];

function wasmModule({
  importedFunctions = [],
  functions,
  bindgenIdentifiers,
  names = true,
}: Fixture): Uint8Array {
  const imports = importedFunctions.length;
  const bodies = functions.map(({ bodySize }) => {
    if (bodySize < 2) throw new Error("a body needs at least its locals count and end");
    return [...leb(bodySize), 0x00, ...Array<number>(bodySize - 2).fill(0x01), 0x0b];
  });
  const exports = functions.flatMap((fn, i) =>
    (typeof fn.exportAs === "string" ? [fn.exportAs] : (fn.exportAs ?? [])).map((name) => [
      ...text(name),
      0x00,
      ...leb(imports + i),
    ]),
  );
  const named: [number, string][] = [
    ...importedFunctions.map((name, i): [number, string] => [i, name]),
    ...functions.flatMap((fn, i): [number, string][] =>
      fn.name === undefined ? [] : [[imports + i, fn.name]],
    ),
  ];
  const functionNames = vector(named.map(([index, name]) => [...leb(index), ...text(name)]));
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vector([[0x60, 0x00, 0x00]])),
    ...section(
      2,
      vector(importedFunctions.map((name) => [...text("env"), ...text(name), 0x00, 0x00])),
    ),
    ...section(3, vector(functions.map(() => [0x00]))),
    ...section(7, vector(exports)),
    ...section(10, vector(bodies)),
    ...(bindgenIdentifiers
      ? section(0, [
          ...text("__wasm_bindgen_unstable"),
          ...bindgenIdentifiers.flatMap((id) => [0xff, 0, 1, ...text(id)]),
        ])
      : []),
    ...(names
      ? section(0, [...text("name"), 0x01, ...leb(functionNames.length), ...functionNames])
      : []),
  ]);
}

const script = fileURLToPath(new URL("./check-viewer-wasm.ts", import.meta.url));
const viewer = { name: "_RNvCs1_13madori_viewer6render", bodySize: 40 };
const core = { name: "_RNvNtCs2_4core3fmt3pad", bodySize: 30 };

function check(t: TestContext, fixture: Fixture | Uint8Array, bindings?: Fixture | "missing") {
  const dir = mkdtempSync(join(tmpdir(), "viewer-wasm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "madori_viewer.release.wasm");
  writeFileSync(path, fixture instanceof Uint8Array ? fixture : wasmModule(fixture));
  const args = [script, path];
  if (bindings !== undefined) {
    const bindingsPath = join(dir, "madori_viewer_bg.wasm");
    if (bindings !== "missing") writeFileSync(bindingsPath, wasmModule(bindings));
    args.push(bindingsPath);
  }
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

void test("a Wasm with only allowed crates passes and prints the table", (t) => {
  const result = check(t, { functions: [viewer, core] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\| madori_viewer +\| +1 \| +40 \|/m);
  assert.match(result.stdout, /No CAD kernel functions/);
});

const forbiddenSamples: Record<string, string[]> = {
  cadKernel: [
    "_RNvNtCs3_9solidcore4eval7surface",
    "_RNvCs4_13solidcore_ops5union",
    "_RNvYNtCs4_16solidcore_record4Vec3NtNtCs3_9solidcore3tol10ScaledZero11scaled_zero",
  ],
  editingEngine: [
    "_RNvCs5_17solidcraft_engine3run",
    "_RNvCs6_15madori_modeling5build",
    "_RNvYINtNtCs9_5alloc3vec3VecdENtCs6_17solidcraft_engine7Command7execute",
  ],
  uiToolkit: [
    "_RNvCs7_9egui_wgpu4draw",
    "_RNvCs8_4egui3run",
    "_RNvCs9_6epaint4tess",
    "_RNvCsa_5emath4lerp",
    "_RNvCsb_6ecolor4gray",
    "_RNvYNtNtCs5_4wgpu3api6DeviceNtCs7_9egui_wgpu9RenderExt11paint_frame",
  ],
};
for (const [family, symbols] of Object.entries(forbiddenSamples)) {
  for (const symbol of symbols) {
    void test(`a Wasm with a ${family} function fails: ${symbol}`, (t) => {
      const result = check(t, { functions: [viewer, { name: symbol, bodySize: 12 }] });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /^\[viewer-wasm-contents\] The viewer Wasm must not contain/m);
    });
  }
}

void test("a core trait provided method on a kernel self type passes and reports the type", (t) => {
  const fold = "_RNvYNtCs3_9solidcore4IterNtNtNtNtCs2_4core4iter6traits8iterator8Iterator4fold";
  const result = check(t, { functions: [viewer, { name: fold, bodySize: 20 }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Its types appear in 1 function of core\./);
});

void test("a kernel type inside another crate's function is reported, not failed", (t) => {
  const drop =
    "_RNvXs_NtCs9_5alloc3vecINtNtCs9_5alloc3vec3VecNtNtCs3_9solidcore4eval7SurfaceENtNtNtCs2_4core3ops4drop4Drop4drop";
  const result = check(t, { functions: [viewer, { name: drop, bodySize: 20 }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /No CAD kernel functions .*Its types appear in 1 function of alloc\./,
  );
});

void test("names are looked up past the imported functions", (t) => {
  const result = check(t, {
    importedFunctions: ["_RNvNtCs3_9solidcore4eval7surface", "__wbg_createBuffer_d800e9b1d41b2ee5"],
    functions: [viewer],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\| madori_viewer +\| +1 \| +40 \|/m);
});

for (const [label, fixture, message] of [
  ["no name section", { functions: [viewer], names: false }, /no function names/],
  [
    "a legacy name",
    { functions: [viewer, { name: "_ZN4core3fmt3pad17h0123456789abcdefE", bodySize: 9 }] },
    /legacy mangling/,
  ],
  [
    "a malformed v0 name",
    { functions: [viewer, { name: "_RNvC", bodySize: 9 }] },
    /cannot be attributed/,
  ],
  ["an unnamed function", { functions: [viewer, { bodySize: 9 }] }, /has no name/],
  ["no viewer function", { functions: [core] }, /No function is attributed to madori_viewer/],
] as const) {
  void test(`a Wasm with ${label} fails`, (t) => {
    const result = check(t, fixture);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });
}

void test("a truncated file fails with the byte offset", (t) => {
  const bytes = wasmModule({ functions: [viewer, core] });
  const result = check(t, bytes.subarray(0, bytes.length - 7));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /at byte \d+/);
});

const checkedFamilies = [
  ...new Set([
    ...viewerWasmBoundary.forbidden,
    ...rustBoundaries.flatMap((row) =>
      row.crate === viewerWasmBoundary.crate && row.kind === "graph" ? row.forbidden : [],
    ),
  ]),
];
void test("forbidden samples cover every family checked on viewer artifacts", () => {
  assert.deepEqual(Object.keys(forbiddenSamples).sort(), checkedFamilies.sort());
});

void test("a real rustc kernel trait provided method on an allowed self type fails", (t) => {
  const symbol =
    "_RNvYNtCsdTUqOBA0g4_14solidcore_tess8TessPlanNtCsdvF1IF33T0o_9solidcore11EvalSurface11scaled_zeroCsfnYGzNUP3Pv_13madori_viewer";
  const result = check(t, { functions: [viewer, { name: symbol, bodySize: 20 }] });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /CAD kernel: solidcore has 1 functions, 20 B/);
  assert.match(result.stderr, new RegExp(symbol, "u"));
});

void test("an instantiating-crate-only mention is excluded from the types clause", (t) => {
  const symbol =
    "_RNvMs5_NtCs5JHfeWeQK0x_5alloc7raw_vecNtB5_11RawVecInner11finish_growCsdaTYTjkd8XF_9solidcore.llvm.12542934454564879836";
  const result = check(t, { functions: [viewer, { name: symbol, bodySize: 20 }] });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Its types appear/);
});

void test("one function naming both kernel crates counts once for the family", (t) => {
  const symbol =
    "_RNvXs_NtCs9_5alloc3vecINtNtCs9_5alloc3vec3VecTNtNtCs3_9solidcore4eval7SurfaceNtCs4_13solidcore_ops4FaceEENtNtNtCs2_4core3ops4drop4Drop4drop";
  const result = check(t, { functions: [viewer, { name: symbol, bodySize: 20 }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Its types appear in 1 function of alloc\./);
});

const hash = "0123456789abcdef";
const exported = (name: string, bodySize = 12) => ({ name, bodySize, exportAs: name });

void test("exported descriptors are excluded and listed names count toward their crates", (t) => {
  const result = check(t, {
    functions: [
      viewer,
      exported("__wbindgen_describe_render", 10),
      exported("__wbindgen_malloc", 5),
      exported("__wbg_jspi_task_poll", 6),
      { name: "memcmp", bodySize: 7 },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /whole code section contains 68 B in 5 functions/);
  assert.match(result.stdout, /leaves out 1 wasm-bindgen descriptors \(10 B\)/);
  assert.match(result.stdout, /\| total +\| +4 \| +58 \| +100.0%/u);
  assert.match(result.stdout, /^\| wasm_bindgen +\| +1 \| +5 \|/m);
  assert.match(result.stdout, /^\| js_sys +\| +1 \| +6 \|/m);
  assert.match(result.stdout, /^\| compiler_builtins +\| +1 \| +7 \|/m);
  assert.doesNotMatch(result.stdout, /wasm-bindgen glue|other unmangled|exported, unmangled/);
});

for (const [fn, message] of [
  [
    exported("solidcore_probe_exported"),
    /solidcore_probe_exported \(exported\): unmangled name with no known origin/,
  ],
  [
    { name: "solidcore_probe_private", bodySize: 12 },
    /solidcore_probe_private \(not exported\): unmangled name with no known origin/,
  ],
  [
    exported("memcmp"),
    /memcmp: exported, but compiler_builtins does not export it, so another crate defines it/,
  ],
  [
    { name: "__wbindgen_malloc", bodySize: 5 },
    /__wbindgen_malloc: not exported, but wasm_bindgen exports it, so another crate defines it/,
  ],
  [
    exported("viewer_draw_ffffffffffffffff"),
    /viewer_draw_ffffffffffffffff.*suffix matches no wasm-bindgen crate identifier/,
  ],
  [{ name: `viewer_draw_${hash}`, bodySize: 5 }, /viewer_draw_.*not exported.*no known origin/],
  [{ name: "__wbindgen_describe_x", bodySize: 9 }, /__wbindgen_describe_x.*no known origin/],
  [
    { ...viewer, exportAs: ["__wbindgen_describe_noop", "solidcore_probe_alias"] },
    /solidcore_probe_alias.*no known origin/,
  ],
] as const) {
  void test(`unattributable symbol fails with ${message.source}`, (t) => {
    const result = check(t, {
      functions: [viewer, fn],
      bindgenIdentifiers: [`madori-viewer-${hash}`],
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /unmangledOwners.*family check/);
  });
}

void test("viewer exports and struct shims count toward the viewer by hash", (t) => {
  const result = check(t, {
    functions: [viewer, exported(`viewer_draw_${hash}`), exported(`__wbg_viewer_free_${hash}`)],
    bindgenIdentifiers: [`madori-viewer-${hash}`],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\| madori_viewer +\| +3 \| +64 \|/m);
});

for (const [pkg, family] of [
  ["solidcore", "CAD kernel"],
  ["solidcraft-engine", "editing engine"],
  ["egui", "UI toolkit"],
] as const) {
  void test(`an export with the hash of ${pkg} fails as ${family}`, (t) => {
    const result = check(t, {
      functions: [viewer, exported(`draw_${hash}`)],
      bindgenIdentifiers: [`${pkg}-${hash}`],
    });
    assert.equal(result.status, 1, result.stdout);
    assert.ok(
      result.stderr.includes(`${family}: ${pkg.replaceAll("-", "_")} has 1 functions, 12 B`),
      result.stderr,
    );
  });
}

void test("two packages claiming one hash fail even if their crate names coincide", (t) => {
  const result = check(t, {
    functions: [viewer],
    bindgenIdentifiers: [`pkg-name-${hash}`, `pkg_name-${hash}`],
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /names both pkg-name and pkg_name/);
});

void test("merged exports count once in the table and once per defining crate for families", (t) => {
  const result = check(t, {
    functions: [{ ...viewer, exportAs: [`zoom_${hash}`, `draw_${hash}`] }],
    bindgenIdentifiers: [`solidcore-${hash}`],
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\| madori_viewer +\| +1 \| +40 \|/m);
  assert.match(result.stdout, /^\| total +\| +1 \| +40 \|/m);
  assert.match(result.stderr, /CAD kernel: solidcore has 1 functions, 40 B/);
  assert.ok(result.stderr.includes(`zoom_${hash}`));
});

void test("a merged wasm-bindgen runtime alias passes", (t) => {
  const result = check(t, {
    functions: [
      viewer,
      {
        name: "_RNvNtCs1_12wasm_bindgen4___rt19link_mem_intrinsics",
        exportAs: "__wbindgen_skip_interpret_calls",
        bodySize: 3,
      },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\| wasm_bindgen +\| +1 \| +3 \|/m);
});

for (const [label, bindings, status, message] of [
  [
    "matching",
    { functions: [{ name: "madori_viewer[3]::render", bodySize: 2 }] },
    0,
    /No CAD kernel/,
  ],
  [
    "mismatching",
    { functions: [{ name: "madori_viewer[4]::render", bodySize: 2 }] },
    1,
    /provenance mismatch/,
  ],
  ["without a crate hash", { functions: [{ name: "render", bodySize: 2 }] }, 1, /hashes.*missing/],
  ["missing", "missing", 1, /Missing bindings.*pnpm setup/],
] as const) {
  void test(`the provenance guard handles ${label} bindings`, (t) => {
    const result = check(t, { functions: [viewer] }, bindings);
    assert.equal(result.status, status, result.stderr || result.stdout);
    assert.match(status === 0 ? result.stdout : result.stderr, message);
  });
}

void test("the pure inspector reports the same provenance mismatch", () => {
  const result = inspectViewerWasm(
    wasmModule({ functions: [viewer] }),
    wasmModule({ functions: [{ name: "madori_viewer[4]::render", bodySize: 2 }] }),
  );
  assert.match(result.violations.join("\n"), /provenance mismatch/);
});

void test("every forbidden Cargo package compiles under its default crate name", () => {
  const metadata = z
    .object({
      packages: z.array(
        z.object({
          name: z.string(),
          targets: z.array(z.object({ name: z.string(), kind: z.array(z.string()) })),
        }),
      ),
    })
    .parse(
      JSON.parse(
        execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        }),
      ),
    );
  let matched = 0;
  for (const pkg of metadata.packages) {
    if (!checkedFamilies.some((family) => crateFamilies[family].pattern.test(pkg.name))) continue;
    matched++;
    const libraries = pkg.targets.filter((target) =>
      target.kind.some((kind) =>
        ["lib", "rlib", "cdylib", "dylib", "staticlib", "proc-macro"].includes(kind),
      ),
    );
    assert(libraries.length > 0, pkg.name);
    for (const target of libraries)
      assert.equal(target.name, pkg.name.replaceAll("-", "_"), pkg.name);
  }
  assert(matched > 0, "metadata must include forbidden packages");
});
