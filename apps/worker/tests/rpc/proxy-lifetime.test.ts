import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL, fileURLToPath } from "node:url";
import { test } from "node:test";

void test("platform proxy keeps in-flight D1 statements alive through GC", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", fileURLToPath(new URL("./proxy-lifetime-fixture.ts", import.meta.url))],
    { timeout: 60000 },
  );
  assert.match(stdout, /The real D1 batch survived GC/u);
});
