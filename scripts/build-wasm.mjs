import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bindgen = fileURLToPath(new URL("../.tools/bin/wasm-bindgen", import.meta.url));
try {
  const version = execFileSync(bindgen, ["--version"], { encoding: "utf8" }).trim();
  if (version !== "wasm-bindgen 0.2.129") throw new Error(`Unexpected version: ${version}`);
} catch (error) {
  throw new Error("Run pnpm setup:wasm to install the matching wasm-bindgen CLI.", { cause: error });
}
execFileSync("cargo", ["build", "--locked", "-p", "madori-viewer", "--target", "wasm32-unknown-unknown"], { cwd: root, stdio: "inherit" });
execFileSync(bindgen, ["target/wasm32-unknown-unknown/debug/madori_viewer.wasm", "--target", "web", "--out-dir", "crates/viewer/pkg", "--out-name", "madori_viewer"], { cwd: root, stdio: "inherit" });
