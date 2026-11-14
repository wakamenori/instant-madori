import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { repositoryRoot } from "../shared/repository.ts";

void test("the Wasm builder passes release output to wasm-bindgen", async (t) => {
  const commands: { file: string; args: readonly string[] | undefined }[] = [];
  t.mock.method(childProcess, "execFileSync", (file: string, args?: readonly string[]) => {
    commands.push({ file, args });
    return args?.[0] === "--version" ? "wasm-bindgen 0.2.129" : "";
  });
  const logs: string[] = [];
  t.mock.method(console, "info", (message: string) => logs.push(message));
  syncBuiltinESMExports();
  try {
    await import("./build-wasm.ts");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  const bindgen = fileURLToPath(new URL(".tools/bin/wasm-bindgen", repositoryRoot));
  const input = "target/wasm32-unknown-unknown/release/madori_viewer.wasm";
  assert.deepEqual(commands, [
    { file: bindgen, args: ["--version"] },
    {
      file: "cargo",
      args: [
        "build",
        "--locked",
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
