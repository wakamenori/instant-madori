import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

export const profile = "release";
export const platform = "wasm32-unknown-unknown";
export const wasmOutput = `target/${platform}/${profile}/madori_viewer.wasm`;
export const bindings = "crates/viewer/pkg";
const metadata = z.object({
  packages: z.array(
    z.object({
      id: z.string(),
      source: z.string().nullable(),
      manifest_path: z.string(),
    }),
  ),
  resolve: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        deps: z.array(
          z.object({
            pkg: z.string(),
            dep_kinds: z.array(z.object({ kind: z.string().nullable() })),
          }),
        ),
      }),
    ),
  }),
});

function run(root: string, tool: string, args: string[]) {
  return execFileSync(tool, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
}

function localDirectories(root: string) {
  const graph = metadata.parse(
    JSON.parse(
      run(root, "cargo", [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        platform,
      ]),
    ),
  );
  const packages = new Map(graph.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(graph.resolve.nodes.map((node) => [node.id, node.deps]));
  const viewer = graph.packages.find(
    (pkg) => pkg.manifest_path === join(root, "crates/viewer/Cargo.toml"),
  );
  if (!viewer) throw new Error("Missing madori-viewer in Cargo metadata");
  const closure = new Set([viewer.id]);
  const dirs: string[] = [];
  for (const id of closure) {
    const pkg = packages.get(id);
    const deps = nodes.get(id);
    if (!pkg || !deps) throw new Error("Incomplete Cargo resolve graph");
    if (pkg.source === null) {
      const dir = relative(root, dirname(pkg.manifest_path));
      if (!dir || dir.startsWith("..")) return undefined;
      dirs.push(dir);
    }
    for (const dep of deps)
      if (dep.dep_kinds.some(({ kind }) => kind !== "dev")) closure.add(dep.pkg);
  }
  return dirs;
}

const buildEnvironment =
  /^(?:CARGO_|RUST|WASM_BINDGEN_|WBG_|MACOSX_DEPLOYMENT_TARGET$|SDKROOT$|CC(?:_|$)|CFLAGS|AR(?:_|$)|SOURCE_DATE_EPOCH$|OPT_LEVEL$|DEBUG$)/u;

export function wasmFingerprint(root: string, bindgenVersion: string, toolFingerprint: string) {
  const hash = createHash("sha256");
  const add = (name: string, bytes: string | Buffer) => {
    hash.update(JSON.stringify([name, Buffer.byteLength(bytes)])).update(bytes);
  };
  add("rustc", run(root, "rustc", ["-vV"]));
  add("build-tool", toolFingerprint);
  add("cargo", run(root, "cargo", ["-V"]));
  add("wasm-bindgen", bindgenVersion);
  for (const name of Object.keys(process.env).sort()) {
    if (buildEnvironment.test(name)) add(name, process.env[name] ?? "");
  }
  const dirs = localDirectories(root);
  if (!dirs) return undefined;
  const files = new Set([
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".cargo/config.toml",
    "scripts/build/build-wasm.ts",
    "scripts/build/wasm-cache.ts",
  ]);
  for (const dir of dirs) {
    for (let parent = dirname(dir); parent !== "."; parent = dirname(parent)) {
      const manifest = join(parent, "Cargo.toml");
      if (existsSync(join(root, manifest))) files.add(manifest);
    }
  }
  for (const file of run(root, "git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...dirs,
  ]).split("\0")) {
    if (file && lstatSync(join(root, file), { throwIfNoEntry: false })) files.add(file);
  }
  for (const path of [...files].sort()) add(path, readFileSync(join(root, path)));
  return { key: hash.digest("hex"), files };
}

// rustc emits an empty Make rule for each input, including include_bytes! outside a crate.
export function coversCompilerInputs(root: string, files: ReadonlySet<string>, depInfo: string) {
  const lines = depInfo.split("\n");
  const outDir = lines
    .find((line) => line.startsWith("# env-dep:OUT_DIR="))
    ?.slice("# env-dep:OUT_DIR=".length);
  return lines.every((line) => {
    if (line.startsWith("# env-dep:")) {
      const name = line.slice("# env-dep:".length).split("=")[0] ?? "";
      return name === "OUT_DIR" || buildEnvironment.test(name);
    }
    if (!line.endsWith(":")) return true;
    const path = resolve(root, line.slice(0, -1).replaceAll("\\ ", " "));
    return (
      files.has(relative(root, path)) || (outDir !== undefined && path.startsWith(outDir + "/"))
    );
  });
}

export function coversBuildScriptInputs(
  root: string,
  files: ReadonlySet<string>,
  packageDir: string,
  output: string,
) {
  return output.split("\n").every((line) => {
    const directive = /^cargo::?rerun-if-(changed|env-changed)=(.*)$/u.exec(line);
    if (!directive) return true;
    const value = directive[2] ?? "";
    if (directive[1] === "env-changed") return buildEnvironment.test(value);
    const path = resolve(packageDir, value);
    if (files.has(relative(root, path))) return true;
    return (
      (path === packageDir || path.startsWith(packageDir + "/")) &&
      statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
    );
  });
}

export function cacheDirectory(root: string, tool = "cargo") {
  if (process.env.MADORI_WASM_CACHE === "0" || process.env.GITHUB_ACTIONS === "true") return;
  if (tool === "mbx") {
    const configDir =
      process.platform === "darwin"
        ? join(homedir(), "Library/Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
    // Custom linker profiles and environment overrides can reference external build inputs.
    if (
      existsSync(join(root, ".mbx.toml")) ||
      existsSync(join(configDir, "mbx/config.toml")) ||
      Object.keys(process.env).some((name) => name.startsWith("MBX_"))
    )
      return;
  }
  // External Cargo configuration can select arbitrary compilers, source mirrors and linkers.
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const configs = [
    join(root, ".cargo/config"),
    join(cargoHome, "config"),
    join(cargoHome, "config.toml"),
  ];
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    configs.push(join(dir, ".cargo/config"), join(dir, ".cargo/config.toml"));
    if (dir === dirname(dir)) break;
  }
  if (configs.some((path) => existsSync(path))) return;
  // Linker flags and Cargo configuration can refer to files the package graph cannot enumerate.
  const config = readFileSync(join(root, ".cargo/config.toml"), "utf8")
    .replace(/#[^\n]*/gu, "")
    .trim();
  if (!/^\[build\]\s+jobs\s*=\s*\d+$/u.test(config)) return;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /^(?:RUSTC(?:_|$)|CARGO_BUILD_(?:RUSTC|TARGET_DIR)|CARGO_TARGET_DIR|CARGO_TARGET_.*_LINKER|CARGO_PROFILE_.*_CODEGEN_BACKEND)/u.test(
        name,
      )
    )
      return;
    if (
      name.endsWith("RUSTFLAGS") &&
      !/^(?:\s*-C\s*(?:opt-level|debuginfo|target-feature|codegen-units|panic|lto)=[\w,+-]+\s*)*$/u.test(
        (value ?? "").replaceAll("\u001f", " "),
      )
    )
      return;
  }
  return resolve(
    process.env.MADORI_WASM_CACHE_DIR ??
      join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "instant-madori/wasm"),
  );
}

const entryLimit = 8;
const maxBytes = 32 * 1024 ** 2;

function prune(dir: string) {
  const entries = readdirSync(dir)
    .filter((name) => /^[a-f0-9]{64}\.tar$/u.test(name))
    .map((name) => ({
      name,
      time: statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0,
    }))
    .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
  for (const { name } of entries.slice(entryLimit)) rmSync(join(dir, name), { force: true });
}

export function cacheWasm(
  root: string,
  dir: string,
  fingerprint: () => { key: string; files: ReadonlySet<string> } | undefined,
  build: (files: ReadonlySet<string>) => boolean | void,
) {
  const inputs = fingerprint();
  if (!inputs) {
    build(new Set());
    return;
  }
  const { key, files } = inputs;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archive = join(dir, key + ".tar");
  let contents: Buffer | undefined;
  try {
    contents = readFileSync(archive);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (contents) {
    const staging = mkdtempSync(join(root, ".wasm-restore-"));
    try {
      execFileSync("tar", ["-xf", "-", "-C", staging], {
        input: contents,
        env: { ...process.env, TAR_OPTIONS: "" },
      });
      mkdirSync(join(root, dirname(wasmOutput)), { recursive: true });
      renameSync(join(staging, wasmOutput), join(root, wasmOutput));
      rmSync(join(root, bindings), { recursive: true, force: true });
      renameSync(join(staging, bindings), join(root, bindings));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    console.info(`[wasm] cache hit ${key}`);
    return;
  }
  console.info(`[wasm] cache miss ${key}`);
  if (build(files) === false) {
    console.info("[wasm] compiler used inputs outside the cache key; skipping store");
    return;
  }
  if (key !== fingerprint()?.key)
    throw new Error("Wasm inputs changed during build. Run the build again.");
  const staging = mkdtempSync(join(dir, "store-"));
  try {
    const file = join(staging, "outputs.tar");
    execFileSync("tar", ["-cf", file, "-C", root, bindings, wasmOutput], {
      env: { ...process.env, COPYFILE_DISABLE: "1", TAR_OPTIONS: "" },
    });
    if (statSync(file).size <= maxBytes) renameSync(file, archive);
    prune(dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
