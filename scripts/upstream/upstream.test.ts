import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readUpstreamPin } from "../shared/repository.ts";
import { writeUpstreamPin } from "./upstream.ts";

void test("writing the current upstream pin preserves its repository-formatted bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "madori-upstream-pin-"));
  try {
    const destination = join(directory, "solidcraft.json");
    await writeUpstreamPin(readUpstreamPin(), destination);
    assert.deepEqual(
      readFileSync(destination),
      readFileSync(new URL("../../third_party/solidcraft.json", import.meta.url)),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
