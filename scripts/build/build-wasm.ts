import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";

const root = fileURLToPath(repositoryRoot);
const bindgen = fileURLToPath(new URL(".tools/bin/wasm-bindgen", repositoryRoot));
const profile = "release";
const input = `target/wasm32-unknown-unknown/${profile}/madori_viewer.wasm`;
try {
  const version = execFileSync(bindgen, ["--version"], { encoding: "utf8" }).trim();
  if (version !== "wasm-bindgen 0.2.129") throw new Error(`Unexpected version: ${version}`);
} catch (error) {
  throw new Error("Run pnpm setup to install the matching wasm-bindgen CLI.", {
    cause: error,
  });
}
console.info(`[wasm] profile=${profile}, wasm-bindgen input=${input}`);
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "madori-viewer",
    "--target",
    "wasm32-unknown-unknown",
    "--profile",
    profile,
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync(
  bindgen,
  [input, "--target", "web", "--out-dir", "crates/viewer/pkg", "--out-name", "madori_viewer"],
  { cwd: root, stdio: "inherit" },
);
