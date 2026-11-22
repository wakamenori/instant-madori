import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";
import { crateFamilies, rustBoundaries, viewerWasmBoundary } from "./boundaries.ts";
import { v0Crates, V0SymbolError, type RustSymbol } from "./rust-symbols.ts";
// Node provides WebAssembly at runtime, but TypeScript declares it only in the DOM and web worker libraries.
declare const WebAssembly: { validate(bytes: Uint8Array): boolean };

class WasmFormatError extends Error {}

type WasmFunction = {
  index: number;
  name: string | undefined;
  exportNames: readonly string[];
  bodySize: number;
};

type WasmModule = {
  bytes: number;
  imports: number;
  functions: WasmFunction[];
  hasFunctionNames: boolean;
  bindgenCrates: ReadonlyMap<string, string>;
};

type Cursor = { bytes: Uint8Array; pos: number; end: number };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function fail(c: Cursor, message: string) {
  return new WasmFormatError(`${message} at byte ${c.pos}`);
}

function byte(c: Cursor) {
  if (c.pos >= c.end) throw fail(c, "unexpected end");
  return c.bytes[c.pos++] ?? 0;
}

function u32(c: Cursor) {
  let result = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const b = byte(c);
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      if (result > 0xffffffff) throw fail(c, "u32 overflow");
      return result;
    }
  }
  throw fail(c, "u32 too long");
}

function skipLeb(c: Cursor) {
  for (let i = 0; i < 10; i++) if ((byte(c) & 0x80) === 0) return;
  throw fail(c, "LEB128 too long");
}

function name(c: Cursor) {
  const length = u32(c);
  if (c.pos + length > c.end) throw fail(c, "name runs past its section");
  let text: string;
  try {
    text = utf8.decode(c.bytes.subarray(c.pos, c.pos + length));
  } catch {
    throw fail(c, "invalid UTF-8 name");
  }
  c.pos += length;
  return text;
}

function skipValueType(c: Cursor) {
  const t = byte(c);
  if (t === 0x63 || t === 0x64) skipLeb(c);
}

function skipLimits(c: Cursor) {
  const flags = byte(c);
  skipLeb(c);
  if (flags & 1) skipLeb(c);
}

function readBindgenPackages(c: Cursor, packages: Map<string, string>) {
  // The crate identifier is length-prefixed inside opaque wasm-bindgen metadata.
  while (c.pos < c.end) {
    const length = byte(c);
    const end = c.pos + length;
    if (length < 18 || end > c.end || c.bytes[end - 17] !== 0x2d) continue;
    let identifier: string;
    try {
      identifier = utf8.decode(c.bytes.subarray(c.pos, end));
    } catch {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)-([0-9a-f]{16})$/u.exec(identifier);
    if (!match) continue;
    const [, pkg, hash] = match;
    if (pkg === undefined || hash === undefined) continue;
    const previous = packages.get(hash);
    if (previous !== undefined && previous !== pkg) {
      throw fail(c, `wasm-bindgen crate hash ${hash} names both ${previous} and ${pkg}`);
    }
    packages.set(hash, pkg);
  }
}

function readWasmModule(bytes: Uint8Array): WasmModule {
  const top: Cursor = { bytes, pos: 0, end: bytes.length };
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const expected of header) {
    if (byte(top) !== expected) throw fail(top, "not a Wasm 1.0 module");
  }
  let imports = 0;
  let declared: number | undefined;
  const bodySizes: number[] = [];
  let hasFunctionNames = false;
  const names = new Map<number, string>();
  const exportNames = new Map<number, string[]>();
  const bindgenPackages = new Map<string, string>();
  while (top.pos < top.end) {
    const id = byte(top);
    const size = u32(top);
    if (top.pos + size > top.end) throw fail(top, `section ${id} runs past the end`);
    const c: Cursor = { bytes, pos: top.pos, end: top.pos + size };
    top.pos = c.end;
    if (id === 0) {
      const section = name(c);
      if (section === "__wasm_bindgen_unstable") readBindgenPackages(c, bindgenPackages);
      if (section !== "name") continue;
      while (c.pos < c.end) {
        const sub = byte(c);
        const subSize = u32(c);
        const s: Cursor = { bytes, pos: c.pos, end: c.pos + subSize };
        if (s.end > c.end) throw fail(c, "name subsection runs past its section");
        c.pos = s.end;
        if (sub !== 1) continue;
        hasFunctionNames = true;
        const count = u32(s);
        for (let i = 0; i < count; i++) {
          const index = u32(s);
          if (names.has(index)) throw fail(s, `function ${index} named twice`);
          names.set(index, name(s));
        }
        if (s.pos !== s.end) throw fail(s, "function names subsection has trailing bytes");
      }
    } else if (id === 2) {
      const count = u32(c);
      for (let i = 0; i < count; i++) {
        name(c);
        name(c);
        const kind = byte(c);
        if (kind === 0) {
          u32(c);
          imports++;
        } else if (kind === 1) {
          skipValueType(c);
          skipLimits(c);
        } else if (kind === 2) skipLimits(c);
        else if (kind === 3) {
          skipValueType(c);
          byte(c);
        } else if (kind === 4) {
          byte(c);
          u32(c);
        } else throw fail(c, `unknown import kind ${kind}`);
      }
      if (c.pos !== c.end) throw fail(c, "import section has trailing bytes");
    } else if (id === 3) {
      declared = u32(c);
    } else if (id === 7) {
      const count = u32(c);
      for (let i = 0; i < count; i++) {
        const exportName = name(c);
        const kind = byte(c);
        const index = u32(c);
        if (kind === 0) {
          const names = exportNames.get(index) ?? [];
          names.push(exportName);
          exportNames.set(index, names);
        }
      }
    } else if (id === 10) {
      const count = u32(c);
      for (let i = 0; i < count; i++) {
        const bodySize = u32(c);
        if (c.pos + bodySize > c.end) throw fail(c, `body ${i} runs past the code section`);
        bodySizes.push(bodySize);
        c.pos += bodySize;
      }
      if (c.pos !== c.end) throw fail(c, "code section has trailing bytes");
    }
  }
  if ((declared ?? 0) !== bodySizes.length) {
    throw fail(
      top,
      `function section declares ${declared ?? 0} functions but the code section has ${bodySizes.length}`,
    );
  }
  if (!WebAssembly.validate(new Uint8Array(bytes))) throw fail(top, "invalid Wasm module");
  return {
    bytes: bytes.length,
    imports,
    functions: bodySizes.map((bodySize, i) => ({
      index: imports + i,
      name: names.get(imports + i),
      exportNames: exportNames.get(imports + i) ?? [],
      bodySize,
    })),
    hasFunctionNames,
    bindgenCrates: new Map(
      [...bindgenPackages].map(([hash, pkg]) => [hash, pkg.replaceAll("-", "_")]),
    ),
  };
}

type CrateFamily = keyof typeof crateFamilies;
const checkedFamilies = [
  ...new Set<CrateFamily>([
    ...viewerWasmBoundary.forbidden,
    ...rustBoundaries.flatMap((row) =>
      row.crate === viewerWasmBoundary.crate && row.kind === "graph" ? row.forbidden : [],
    ),
  ]),
];

type Usage = { functions: number; bytes: number };
type FamilyFinding = {
  family: CrateFamily;
  crates: { name: string; usage: Usage; examples: string[] }[];
  mentions: Map<string, number>;
};
type ViewerWasmContents = {
  module: {
    bytes: number;
    importedFunctions: number;
    definedFunctions: number;
    codeBytes: number;
    viewerHashes: ReadonlySet<string>;
  };
  crates: [string, Usage][];
  descriptors: Usage;
  families: FamilyFinding[];
  violations: string[];
};

type Origin =
  | { kind: "crate"; symbol: RustSymbol }
  | { kind: "descriptor" }
  | { kind: "unmangled"; crate: string }
  | { kind: "unattributable"; reason: string };

function matchesFamily(crate: string, family: CrateFamily): boolean {
  const { pattern } = crateFamilies[family];
  return pattern.test(crate) || pattern.test(crate.replaceAll("_", "-"));
}

const unmangledOwners = {
  compiler_builtins: {
    exported: false,
    names: [
      "__ashlti3",
      "__lshrti3",
      "__multi3",
      "__udivti3",
      "__umodti3",
      "acosf",
      "atan2f",
      "cos",
      "cosf",
      "exp",
      "fma",
      "fmod",
      "hypot",
      "round",
      "roundf",
      "sin",
      "sinf",
      "tan",
      "memcmp",
    ],
  },
  wasm_bindgen: {
    exported: true,
    names: [
      "__wbindgen_malloc",
      "__wbindgen_realloc",
      "__wbindgen_free",
      "__wbindgen_exn_store",
      "__wbindgen_destroy_closure",
      "__wbindgen_jspi_set_rejected",
      "__wbindgen_skip_interpret_calls",
      "__externref_table_alloc",
      "__externref_table_dealloc",
      "__externref_drop_slice",
    ],
  },
  js_sys: { exported: true, names: ["__wbg_jspi_task_poll"] },
} as const satisfies Record<string, { exported: boolean; names: readonly string[] }>;

const ownerByName = new Map<string, { crate: string; exported: boolean }>();
for (const [crate, { exported, names }] of Object.entries(unmangledOwners)) {
  for (const name of names) {
    if (ownerByName.has(name)) throw new Error(`${name} appears twice in unmangledOwners`);
    ownerByName.set(name, { crate, exported });
  }
}

function originOf(
  name: string | undefined,
  fn: WasmFunction,
  bindgenCrates: ReadonlyMap<string, string>,
): Origin {
  if (name === undefined) {
    return { kind: "unattributable", reason: `function ${fn.index} has no name` };
  }
  if (name.startsWith("_ZN")) {
    return {
      kind: "unattributable",
      reason: `${name}: legacy mangling; the check reads v0 names only`,
    };
  }
  if (name.startsWith("_R")) {
    try {
      return { kind: "crate", symbol: v0Crates(name) };
    } catch (error) {
      if (!(error instanceof V0SymbolError)) throw error;
      return { kind: "unattributable", reason: `${name}: ${error.message}` };
    }
  }
  const exported = fn.exportNames.length > 0;
  if (exported && name.startsWith("__wbindgen_describe_")) return { kind: "descriptor" };
  const hash = /_([0-9a-f]{16})$/u.exec(name)?.[1];
  const crate = hash === undefined ? undefined : bindgenCrates.get(hash);
  if (exported && crate !== undefined) return { kind: "unmangled", crate };
  const owner = ownerByName.get(name);
  const status = exported ? "exported" : "not exported";
  if (owner) {
    if (exported === owner.exported) return { kind: "unmangled", crate: owner.crate };
    return {
      kind: "unattributable",
      reason: `${name}: ${status}, but ${owner.crate} ${owner.exported ? "exports it" : "does not export it"}, so another crate defines it`,
    };
  }
  const suffix =
    hash !== undefined && crate === undefined
      ? "; its suffix matches no wasm-bindgen crate identifier"
      : "";
  return {
    kind: "unattributable",
    reason: `${name} (${status}): unmangled name with no known origin${suffix}`,
  };
}

function add<K extends string>(map: Map<K, Usage>, key: K, bytes: number) {
  const usage = map.get(key) ?? { functions: 0, bytes: 0 };
  usage.functions++;
  usage.bytes += bytes;
  map.set(key, usage);
}

const byBytes = <K extends string>(a: [K, Usage], b: [K, Usage]) =>
  b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]);

export function inspectViewerWasm(bytes: Uint8Array, bindings?: Uint8Array): ViewerWasmContents {
  const module = readWasmModule(bytes);
  const crates = new Map<string, Usage>();
  const familyUsage = new Map<string, Usage>();
  const descriptors: Usage = { functions: 0, bytes: 0 };
  const findings = new Map<CrateFamily, FamilyFinding>(
    checkedFamilies.map((family) => [family, { family, crates: [], mentions: new Map() }]),
  );
  const examples = new Map<string, string[]>();
  const problems: string[] = [];
  const unattributed: string[] = [];
  const viewerHashes = new Set<string>();
  const viewerCrate = viewerWasmBoundary.crate.replaceAll("-", "_");
  if (!module.hasFunctionNames) {
    problems.push(
      "The Wasm has no function names. Keep symbols in the release profile (strip only debuginfo) and remove names in wasm-bindgen instead.",
    );
  }
  for (const fn of module.functions) {
    const owners = new Map<string, string>();
    const reasons: string[] = [];
    for (const name of new Set([fn.name, ...fn.exportNames])) {
      const origin = originOf(name, fn, module.bindgenCrates);
      if (origin.kind === "unattributable") {
        reasons.push(origin.reason);
        continue;
      }
      if (origin.kind === "descriptor" || name === undefined) continue;
      const crate = origin.kind === "crate" ? origin.symbol.owner.name : origin.crate;
      if (!owners.has(crate)) owners.set(crate, name);
      if (origin.kind === "crate" && name === fn.name) {
        const { owner, pathCrates } = origin.symbol;
        if (crate === viewerCrate) viewerHashes.add(owner.disambiguator.toString(16));
        for (const finding of findings.values()) {
          if (
            !matchesFamily(crate, finding.family) &&
            [...pathCrates].some((other) => matchesFamily(other, finding.family))
          ) {
            finding.mentions.set(crate, (finding.mentions.get(crate) ?? 0) + 1);
          }
        }
      }
    }
    if (reasons.length > 0) {
      unattributed.push(...reasons);
      continue;
    }
    const first = owners.keys().next();
    if (first.done) {
      descriptors.functions++;
      descriptors.bytes += fn.bodySize;
      continue;
    }
    add(crates, first.value, fn.bodySize);
    for (const [crate, symbol] of owners) {
      add(familyUsage, crate, fn.bodySize);
      const list = examples.get(crate) ?? [];
      if (list.length < 5) list.push(symbol);
      examples.set(crate, list);
    }
  }
  for (const [crate, usage] of familyUsage) {
    for (const finding of findings.values()) {
      if (matchesFamily(crate, finding.family)) {
        finding.crates.push({ name: crate, usage, examples: examples.get(crate) ?? [] });
      }
    }
  }
  if (bindings !== undefined) {
    const bindingHashes = new Set(
      readWasmModule(bindings).functions.flatMap((fn) =>
        [...(fn.name ?? "").matchAll(/\bmadori_viewer\[([0-9a-f]+)\]/gu)].map((match) =>
          BigInt(`0x${match[1]}`).toString(16),
        ),
      ),
    );
    if (
      viewerHashes.size !== 1 ||
      bindingHashes.size !== 1 ||
      [...viewerHashes][0] !== [...bindingHashes][0]
    ) {
      problems.push(
        `Viewer provenance mismatch: release crate hashes [${[...viewerHashes].join(", ")}] and bindings crate hashes [${[...bindingHashes].join(", ")}] differ or are missing. The shared target may hold another build. Rerun pnpm check --full.`,
      );
    }
  }
  if (module.hasFunctionNames && !crates.has(viewerCrate)) {
    problems.push(
      `No function is attributed to ${viewerCrate}, so the names do not show where code comes from.`,
    );
  }
  if (unattributed.length > 0) {
    problems.push(
      `${unattributed.length} function names cannot be attributed to a crate:\n  ${unattributed.slice(0, 10).join("\n  ")}\n  To attribute an unmangled name, list it in unmangledOwners in scripts/check/check-viewer-wasm.ts under the crate that defines it. The family check applies to that crate.`,
    );
  }
  const violations = problems.map((problem) => `[${viewerWasmBoundary.id}] ${problem}`);
  for (const finding of findings.values()) {
    for (const { name, usage, examples: names } of finding.crates) {
      violations.push(
        `[${viewerWasmBoundary.id}] ${viewerWasmBoundary.message} ${crateFamilies[finding.family].label}: ${name} has ${usage.functions} functions, ${usage.bytes} B (${viewerWasmBoundary.reason})\n  ${names.join("\n  ")}`,
      );
    }
  }
  return {
    module: {
      bytes: module.bytes,
      importedFunctions: module.imports,
      definedFunctions: module.functions.length,
      codeBytes: module.functions.reduce((sum, fn) => sum + fn.bodySize, 0),
      viewerHashes,
    },
    crates: [...crates].sort(byBytes),
    descriptors,
    families: [...findings.values()],
    violations,
  };
}

const n = (value: number) => value.toLocaleString("en-US");

function formatContents(path: string, contents: ViewerWasmContents): string {
  const rows = contents.crates;
  const total = rows.reduce(
    (sum, [, usage]) => ({
      functions: sum.functions + usage.functions,
      bytes: sum.bytes + usage.bytes,
    }),
    { functions: 0, bytes: 0 },
  );
  const cells = [
    ["crate", "functions", "code (B)", "share"],
    ...[...rows, ["total", total] satisfies [string, Usage]].map(([name, usage]) => [
      name,
      n(usage.functions),
      n(usage.bytes),
      `${(total.bytes === 0 ? 0 : (100 * usage.bytes) / total.bytes).toFixed(1)}%`,
    ]),
  ];
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(...cells.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: string[]) =>
    `| ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[0] ?? 0) : cell.padStart(widths[column] ?? 0))).join(" | ")} |`;
  const header = cells[0] ?? [];
  const rule = `| ${"-".repeat(widths[0] ?? 0)} | ${widths
    .slice(1)
    .map((width) => `${"-".repeat(width - 1)}:`)
    .join(" | ")} |`;
  const { module, descriptors } = contents;
  const familyLines = contents.families.map(({ family, crates, mentions }) => {
    const { label, pattern } = crateFamilies[family];
    if (crates.length > 0)
      return `[wasm] ${label} ${String(pattern)}: ${crates.map((c) => c.name).join(", ")}`;
    const mentioned = [...mentions].sort((a, b) => b[1] - a[1]);
    const total = mentioned.reduce((sum, [, count]) => sum + count, 0);
    const owners =
      mentioned.length === 1
        ? (mentioned[0]?.[0] ?? "")
        : mentioned.map(([crate, count]) => `${crate} (${count})`).join(", ");
    const note = mentioned.length
      ? ` Its types appear in ${total} function${total === 1 ? "" : "s"} of ${owners}.`
      : "";
    return `[wasm] No ${label} functions ${String(pattern)}.${note}`;
  });
  return [
    `[wasm] ${path}: release build before wasm-bindgen, ${n(module.bytes)} B, ${n(module.importedFunctions)} imported and ${n(module.definedFunctions)} defined functions.`,
    `[wasm] The whole code section contains ${n(module.codeBytes)} B in ${n(module.definedFunctions)} functions (body sizes without length prefixes).`,
    `[wasm] The table leaves out ${n(descriptors.functions)} wasm-bindgen descriptors (${n(descriptors.bytes)} B) that wasm-bindgen removes.`,
    line(header),
    rule,
    ...cells.slice(1).map(line),
    ...familyLines,
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const path =
    args[0] ??
    fileURLToPath(
      new URL("target/wasm32-unknown-unknown/release/madori_viewer.wasm", repositoryRoot),
    );
  const bindings =
    args[1] ??
    (args.length === 0
      ? fileURLToPath(new URL("crates/viewer/pkg/madori_viewer_bg.wasm", repositoryRoot))
      : undefined);
  try {
    if (args.length > 2)
      throw new Error("usage: node scripts/check/check-viewer-wasm.ts [<wasm> [<bindings>]]");
    if (bindings !== undefined && !existsSync(bindings)) {
      throw new Error(`Missing bindings ${bindings}. Run pnpm setup first.`);
    }
    const contents = inspectViewerWasm(
      readFileSync(path),
      bindings === undefined ? undefined : readFileSync(bindings),
    );
    console.log(formatContents(path, contents));
    if (contents.violations.length > 0) {
      console.error(contents.violations.join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `[${viewerWasmBoundary.id}] ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
