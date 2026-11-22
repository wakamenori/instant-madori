import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { repositoryRoot } from "../shared/repository.ts";

import { buildWasm, parseLocalBuild, verifyProvenance } from "./build-wasm.ts";

function artifacts(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "wasm-artifacts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "deps"));
  const viewer = join(dir, "deps/madori_viewer.d");
  const display = join(dir, "deps/madori_display-123.d");
  writeFileSync(viewer, `${viewer}:\n`);
  writeFileSync(display, `${display}: crates/display/src/lib.rs\n`);
  const message = (name: string, filenames: string[], source = "path+file://", kind = "lib") =>
    JSON.stringify({
      reason: "compiler-artifact",
      package_id: source + name,
      target: { name, kind: [kind] },
      filenames: filenames.map((file) => join(dir, file)),
    });
  const output = [
    message("madori_viewer", ["madori_viewer.wasm", "libmadori_viewer.rlib"]),
    message("madori_display", ["deps/libmadori_display-123.rlib"]),
    message("serde", ["deps/libserde-123.rlib"], "registry+"),
    message("build-script-build", ["build-script-build"], "path+file://", "custom-build"),
    JSON.stringify({ reason: "build-finished" }),
  ].join("\n");
  return { output, display, viewer };
}

void test("the Wasm builder passes release output to wasm-bindgen", (t) => {
  const { output, viewer, display } = artifacts(t);
  assert.deepEqual(parseLocalBuild(output).units, [
    { crate: "madori_viewer", depInfo: viewer },
    { crate: "madori_display", depInfo: display },
  ]);
  const commands: { file: string; args: readonly string[] | undefined }[] = [];
  t.mock.method(childProcess, "execFileSync", (file: string, args?: readonly string[]) => {
    commands.push({ file, args });
    if (file === "cargo") return output;
    return args?.[0] === "--version" ? "wasm-bindgen 0.2.129" : "";
  });
  const logs: string[] = [];
  t.mock.method(console, "info", (message: string) => logs.push(message));
  syncBuiltinESMExports();
  const root = mkdtempSync(join(tmpdir(), "wasm-compile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bypass = process.env.MADORI_WASM_CACHE;
  process.env.MADORI_WASM_CACHE = "0";
  try {
    buildWasm(root);
  } finally {
    if (bypass === undefined) delete process.env.MADORI_WASM_CACHE;
    else process.env.MADORI_WASM_CACHE = bypass;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  const bindgen = join(root, ".tools/bin/wasm-bindgen");
  const input = "target/wasm32-unknown-unknown/release/madori_viewer.wasm";
  assert.deepEqual(commands, [
    { file: bindgen, args: ["--version"] },
    {
      file: "cargo",
      args: [
        "build",
        "--locked",
        "--message-format=json-render-diagnostics",
        "-p",
        "madori-viewer",
        "--target",
        "wasm32-unknown-unknown",
        "--profile",
        "release",
      ],
    },
    {
      file: bindgen,
      args: [
        input,
        "--target",
        "web",
        "--out-dir",
        "crates/viewer/pkg",
        "--out-name",
        "madori_viewer",
      ],
    },
  ]);
  assert.deepEqual(logs, [`[wasm] profile=release, wasm-bindgen input=${input}`]);
});

void test("setup, dev and build use the same Wasm builder", () => {
  const { scripts } = z
    .object({ scripts: z.object({ setup: z.string(), dev: z.string(), build: z.string() }) })
    .parse(JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")));
  for (const command of Object.values(scripts)) {
    assert(command.split(" && ").includes("node scripts/build/build-wasm.ts"), command);
  }
});

void test("rejects foreign rustc dep-info and reports the recorded checkout", (t) => {
  const { display, output } = artifacts(t);
  const foreign = "/another/target/deps/madori_display-123.d";
  writeFileSync(display, `${foreign}: crates/display/src/lib.rs\n`);
  assert.throws(
    () => verifyProvenance(parseLocalBuild(output).units),
    /madori_display: \/another\/target.*\nRun pnpm setup/u,
  );
});

void test("rejects missing dep-info or a file without the rustc target line", (t) => {
  const { display, output } = artifacts(t);
  rmSync(display);
  const verify = () => verifyProvenance(parseLocalBuild(output).units);
  assert.throws(verify, /madori_display: missing dep-info target/u);
  writeFileSync(display, "crates/display/src/lib.rs:\n");
  assert.throws(verify, /madori_display: missing dep-info target/u);
});

void test("requires the viewer artifact", () => {
  assert.throws(
    () => verifyProvenance(parseLocalBuild('{"reason":"build-finished"}').units),
    /No madori_viewer unit/u,
  );
});
