import { readFileSync } from "node:fs";

// Paths whose changes need `pnpm check --full` (AGENTS.md: the Container and display path,
// dependencies, upstream, the Wasm API, tool pins, and the CI definition itself).
const fullCheckPrefixes = [
  "apps/geometry/",
  "crates/display/",
  "crates/geometry-api/",
  "crates/modeling/",
  "crates/viewer/",
  "apps/worker/src/geometry/",
  "apps/worker/src/objects/",
  "apps/worker/src/workflows/",
  "apps/worker/src/services/jobs.ts",
  "apps/worker/src/compose.ts",
  "apps/worker/src/services/geometry.ts",
  "apps/worker/wrangler.jsonc",
  "third_party/",
  ".github/workflows/",
  "scripts/build/",
  ".cargo/",
  "scripts/check/boundaries.ts",
  "scripts/check/check.ts",
  "scripts/check/check-viewer-wasm",
  "scripts/check/rust-symbols",
  "Cargo.toml",
  "Cargo.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "mise.toml",
  "rust-toolchain.toml",
];
const fullCheckNames = ["package.json", "Cargo.toml", "Dockerfile"];

export function checkModeFor(files: readonly string[]): "default" | "full" {
  return files.some(
    (file) =>
      fullCheckPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)) ||
      fullCheckNames.includes(file.split("/").at(-1) ?? ""),
  )
    ? "full"
    : "default";
}

if (import.meta.main) {
  const files = readFileSync(0, "utf8").split("\n").filter(Boolean);
  process.stdout.write(checkModeFor(files) === "full" ? "--full" : "");
}
