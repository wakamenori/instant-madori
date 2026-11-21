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

void test("discovery comments use the parent Issue label and share one lookup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let lookups = 0;
  const request: typeof fetch = (input) => {
    assert.ok(typeof input === "string");
    const url = input;
    if (url.endsWith("/rate_limit"))
      return Promise.resolve(Response.json({ resources: { core: { remaining: 2000 } } }));
    const headers = { "x-ratelimit-remaining": "1800" };
    if (url.includes("/issues/comments?")) {
      const comment = {
        body: "```yaml\nfound_at: マージの後\nfound_by: 担当\ncause: 不明\n```",
        user: { login: "fixture" },
        issue_url: "issues/12",
        created_at: "2026-11-20T00:00:00Z",
      };
      return Promise.resolve(
        Response.json(
          [
            { ...comment, id: 1 },
            { ...comment, id: 2 },
          ],
          { headers },
        ),
      );
    }
    assert.ok(url.endsWith("/issues/12/labels?per_page=100"));
    lookups++;
    return Promise.resolve(
      Response.json([{ name: "製品の不具合：約束どおりに動かない製品を直す" }], { headers }),
    );
  };
  const poller = githubPollers(root, () => Promise.resolve("fixture"), request).find(
    (p) => p.name === "github.comment",
  );
  assert.ok(poller);
  const rows = await poller.poll(new AbortController().signal);
  assert.equal(lookups, 1);
  assert.equal(rows.length, 2);
  for (const row of rows)
    assert.deepEqual(row.payload.fields, [
      { type: "製品の不具合", found_at: "マージの後", found_by: "担当", cause: "不明" },
    ]);
});
