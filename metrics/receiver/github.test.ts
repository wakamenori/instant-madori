import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubPollers, BudgetLimit } from "./github.ts";
void test("GitHub checks the shared budget first and saves validators only after ingestion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-gh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let remaining = 1499;
  const validators: (string | null)[] = [];
  const request: typeof fetch = (input, options) => {
    assert.equal(typeof input, "string");
    if (typeof input === "string" && input.endsWith("/rate_limit"))
      return Promise.resolve(Response.json({ resources: { core: { remaining } } }));
    validators.push(new Headers(options?.headers).get("if-none-match"));
    return Promise.resolve(
      Response.json([], { headers: { etag: "snapshot", "x-ratelimit-remaining": "1600" } }),
    );
  };
  const p = githubPollers(root, () => Promise.resolve("fixture"), request).find(
    (p) => p.name === "github.pr",
  );
  assert.ok(p);
  const poll = () => Promise.resolve(p.poll(new AbortController().signal));
  await assert.rejects(poll, BudgetLimit);
  assert.equal(validators.length, 0);
  remaining = 2000;
  await poll();
  await poll();
  assert.deepEqual(validators, [null, null]);
  p.committed?.();
  await poll();
  p.committed?.();
  await poll();
  assert.equal(validators.at(-1), "snapshot");
});
