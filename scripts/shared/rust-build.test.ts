import assert from "node:assert/strict";
import { test } from "node:test";
import { mbxStoreSettings } from "./rust-build.ts";

void test("mbx never sweeps the shared store for free disk, because its objects are reflinks of worktree target files and evicting them frees nothing", () => {
  assert.equal(mbxStoreSettings.MBX_GC_MIN_FREE_SIZE, "none");
});
