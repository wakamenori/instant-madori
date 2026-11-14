import assert from "node:assert/strict";
import { test } from "node:test";
import { checkModeFor } from "./ci-mode.ts";

void test("Container, display, dependency, upstream and CI changes need the full check", () => {
  for (const file of [
    "apps/geometry/src/main.rs",
    "apps/geometry/Dockerfile",
    "crates/modeling/src/lib.rs",
    "crates/viewer/src/lib.rs",
    "apps/worker/src/geometry/geometry-client.ts",
    "apps/worker/src/api/sample.ts",
    "apps/worker/wrangler.jsonc",
    "apps/web/package.json",
    "crates/housing/Cargo.toml",
    "pnpm-lock.yaml",
    "third_party/solidcraft/crates/doc/src/lib.rs",
    ".github/workflows/check.yml",
  ]) {
    assert.equal(checkModeFor(["docs/plan.md", file]), "full", file);
  }
});

void test("other service changes use the default check", () => {
  assert.equal(
    checkModeFor([
      "docs/plan.md",
      "apps/worker/src/api/projects.ts",
      "apps/worker/src/storage/d1.ts",
      "apps/web/src/App.tsx",
      "crates/housing/src/lib.rs",
      "scripts/check/boundaries.ts",
    ]),
    "default",
  );
  assert.equal(checkModeFor([]), "default");
});
