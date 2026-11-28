import { readFileSync } from "node:fs";

const geometryContainerAndDisplayFormatPaths = [
  "apps/geometry/",
  "crates/display/",
  "crates/geometry-api/",
  "crates/housing/",
  "crates/modeling/",
  "apps/worker/src/geometry/",
  "apps/worker/src/services/geometry.ts",
  "apps/worker/wrangler.jsonc",
  ".dockerignore",
];
const realContainerJobPaths = [
  "apps/worker/src/objects/",
  "apps/worker/src/workflows/",
  "apps/worker/src/services/jobs.ts",
  "apps/worker/src/compose.ts",
];
const releaseWasmAndUpstreamPaths = ["crates/viewer/", "third_party/", "scripts/build/", ".cargo/"];
const webBuildPaths = [
  "apps/web/vite.config.ts",
  "apps/web/index.html",
  "scripts/dev/dev-session.ts",
];
const dependencyAuditAndToolPinPaths = [
  "Cargo.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "deny.toml",
  "mise.toml",
  "rust-toolchain.toml",
];
const ciAndFullOnlyScriptPaths = [
  ".github/workflows/",
  "scripts/check/check.ts",
  "scripts/check/rust-inputs.ts",
  "scripts/check/layout-contract.ts",
  "scripts/check/test-results.ts",
  "scripts/check/boundaries.ts",
  "scripts/check/check-viewer-wasm",
  "scripts/check/rust-symbols",
  "scripts/check/smoke.ts",
  "scripts/check/check-licenses.ts",
  "scripts/shared/",
  "scripts/dev/prune-images.ts",
  "scripts/dev/prune-build-cache.ts",
  "scripts/dev/local-access.ts",
  "apps/worker/tests/container.e2e.ts",
  "apps/worker/tests/support/",
  "metrics/home.ts",
  "metrics/hook/docker-slot.ts",
  "metrics/hook/spool.ts",
];
const fullCheckPrefixes = [
  ...geometryContainerAndDisplayFormatPaths,
  ...realContainerJobPaths,
  ...releaseWasmAndUpstreamPaths,
  ...webBuildPaths,
  ...dependencyAuditAndToolPinPaths,
  ...ciAndFullOnlyScriptPaths,
];
const fullCheckNames = ["package.json", "Cargo.toml", "Dockerfile"];

type CiMode = "docs" | "default" | "full";
const flags = { docs: "--docs", default: "", full: "--full" } satisfies Record<CiMode, string>;

export function checkModeFor(files: readonly string[]): CiMode {
  if (
    files.some(
      (file) =>
        fullCheckPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)) ||
        fullCheckNames.includes(file.split("/").at(-1) ?? ""),
    )
  )
    return "full";
  return files.length > 0 && files.every((file) => file.endsWith(".md")) ? "docs" : "default";
}

if (import.meta.main) {
  const files = readFileSync(0, "utf8").split("\0").filter(Boolean);
  process.stdout.write(flags[checkModeFor(files)]);
}
