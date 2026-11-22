import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  bindings,
  cacheWasm,
  coversBuildScriptInputs,
  coversCompilerInputs,
  wasmFingerprint,
  wasmOutput,
} from "./wasm-cache.ts";

function scratch(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wasm-cache-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, path: string, text: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

void test("only the viewer's build inputs invalidate a cached build", (t) => {
  const root = scratch(t);
  write(
    root,
    "rust-toolchain.toml",
    readFileSync(new URL("../../rust-toolchain.toml", import.meta.url), "utf8"),
  );
  write(
    root,
    "Cargo.toml",
    '[workspace]\nmembers=["crates/viewer","generator","unused"]\nresolver="3"\n',
  );
  for (const [dir, name] of [
    ["crates/viewer", "madori-viewer"],
    ["generator", "generator"],
    ["unused", "unused"],
  ] as const) {
    write(
      root,
      dir + "/Cargo.toml",
      `[package]\nname="${name}"\nversion="0.1.0"\nedition="2024"\n` +
        (dir === "crates/viewer"
          ? '[build-dependencies]\ngenerator={path="../../generator"}\n'
          : ""),
    );
    write(root, dir + "/src/lib.rs", "");
  }
  for (const path of [
    ".cargo/config.toml",
    "scripts/build/wasm-cache.ts",
    "scripts/build/build-wasm.ts",
  ])
    write(root, path, "");
  write(root, ".gitignore", "/crates/viewer/pkg/\n/target/\n/cache/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("cargo", ["generate-lockfile"], { cwd: root });
  const key = () => wasmFingerprint(root, "bindgen");
  let builds = 0;
  const run = () =>
    cacheWasm(root, join(root, "cache"), key, () => {
      builds++;
      write(root, wasmOutput, String(builds));
      write(root, bindings + "/output.js", String(builds));
    });
  run();
  write(root, "metrics/input.ts", "changed");
  write(root, "apps/worker/src/index.ts", "changed");
  write(root, "unused/src/lib.rs", "changed");
  rmSync(join(root, wasmOutput));
  run();
  assert.equal(readFileSync(join(root, wasmOutput), "utf8"), "1");
  write(root, "generator/src/lib.rs", "pub fn new_function() {}\n");
  run();
  assert.equal(builds, 2);
  write(root, "generator/build.rs", "fn main() {}\n");
  run();
  assert.equal(builds, 3);
  const originalFlags = process.env.RUSTFLAGS;
  try {
    process.env.RUSTFLAGS = (originalFlags ?? "") + " -C opt-level=1";
    run();
    assert.equal(builds, 4);
  } finally {
    if (originalFlags === undefined) delete process.env.RUSTFLAGS;
    else process.env.RUSTFLAGS = originalFlags;
  }
});

void test("concurrent misses publish one complete pair and older archives are pruned", async (t) => {
  const dir = scratch(t);
  const cache = join(dir, "cache");
  const key = "a".repeat(64);
  const files = new Set<string>();
  const first = join(dir, "first");
  const second = join(dir, "second");
  const script = `
    import {existsSync,writeFileSync} from "node:fs";
    import {cacheWasm} from ${JSON.stringify(new URL("./wasm-cache.ts", import.meta.url).href)};
    const [root,other,cache,key] = process.argv.slice(1);
    cacheWasm(root,cache,()=>({key,files:new Set()}),()=>{
      writeFileSync(root+"/ready","");
      const until=Date.now()+15000;
      while(!existsSync(other+"/ready")) {
        if(Date.now()>until) throw Error("second writer missed barrier");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    });
  `;
  await Promise.all(
    (
      [
        [first, second],
        [second, first],
      ] as const
    ).map(async ([root, other]) => {
      write(root, bindings + "/output.js", root);
      write(root, wasmOutput, root);
      await promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        root,
        other,
        cache,
        key,
      ]);
    }),
  );
  const root = first;
  rmSync(join(root, wasmOutput));
  rmSync(join(root, bindings), { recursive: true });
  cacheWasm(
    root,
    cache,
    () => ({ key, files }),
    () => assert.fail("expected hit"),
  );
  assert.equal(
    readFileSync(join(root, wasmOutput), "utf8"),
    readFileSync(join(root, bindings, "output.js"), "utf8"),
  );
  for (let i = 0; i < 8; i++)
    cacheWasm(
      root,
      cache,
      () => ({ key: String(i).repeat(64), files }),
      () => {},
    );
  assert.equal(readdirSync(cache).length, 8);
  assert.equal(existsSync(join(cache, key + ".tar")), false);
});

void test("an input outside the hash prevents publication", (t) => {
  const root = scratch(t);
  const files = new Set(["crate/src/lib.rs"]);
  assert.equal(coversCompilerInputs(root, files, "crate/src/lib.rs:\n"), true);
  assert.equal(coversCompilerInputs(root, files, "crate/src/../../assets/other.txt:\n"), false);
  assert.equal(coversCompilerInputs(root, files, "# env-dep:CUSTOM_BUILD_INPUT=variable"), false);
  assert.equal(
    coversBuildScriptInputs(
      root,
      files,
      join(root, "crate"),
      "cargo:rerun-if-changed=../assets/other",
    ),
    false,
  );
  assert.equal(
    coversBuildScriptInputs(
      root,
      files,
      join(root, "crate"),
      "cargo:rerun-if-env-changed=CUSTOM_BUILD_INPUT",
    ),
    false,
  );
  const dir = join(root, "cache");
  cacheWasm(
    root,
    dir,
    () => ({ key: "a".repeat(64), files }),
    () => false,
  );
  assert.deepEqual(readdirSync(dir), []);
});
