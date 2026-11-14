import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { test } from "node:test";
import { original, verifyCreateOnly } from "./protocol.ts";
import { runStep } from "./worker.ts";
import { credentialsSchema, stagingR2Rest } from "./rest.ts";

function bucketFixture(mode: "conditional" | "overwrite" | "transport" | "delete-failure") {
  let bytes: Uint8Array | null = null;
  let deleted = false;
  const bucket = {
    head: () => Promise.resolve(bytes === null ? null : {}),
    get: () =>
      Promise.resolve(
        bytes === null ? null : { arrayBuffer: () => Promise.resolve(bytes?.slice().buffer) },
      ),
    put: (_key: string, value: Uint8Array) => {
      if (bytes !== null && mode === "transport")
        return Promise.reject(new Error("network failure"));
      if (bytes !== null && mode !== "overwrite") return Promise.resolve(null);
      bytes = value.slice();
      return Promise.resolve({});
    },
    delete: () => {
      deleted = true;
      if (mode === "delete-failure") return Promise.reject(new Error("delete failure"));
      bytes = null;
      return Promise.resolve();
    },
  } as unknown as R2Bucket;
  return { bucket, deleted: () => deleted, bytes: () => bytes };
}

for (const mode of ["conditional", "overwrite", "transport", "delete-failure"] as const) {
  void test(`checker ${mode}, cleanup always runs`, async () => {
    const fixture = bucketFixture(mode);
    const observed: string[] = [];
    const result = verifyCreateOnly(
      (step) => runStep(fixture.bucket, "probe", step),
      (step) => {
        observed.push(step);
        return Promise.resolve();
      },
    );
    if (mode === "conditional") {
      await result;
      assert.deepEqual(observed, ["first", "reject", "direct", "delete"]);
    } else await assert.rejects(result, AggregateError);
    assert(fixture.deleted());
    if (mode !== "delete-failure") assert.equal(fixture.bytes(), null);
  });
}

void test("REST observation rejects local-only success and wrong bytes", async () => {
  const credentials = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "test" };
  for (const response of [new Response(null, { status: 404 }), new Response(new Uint8Array([8]))]) {
    const rest = stagingR2Rest(credentials, "test", () => Promise.resolve(response));
    await assert.rejects(rest.observe("probe", "first"));
  }
  const rest = stagingR2Rest(credentials, "test", () => Promise.resolve(new Response(original)));
  await rest.observe("probe", "reject");
  await assert.rejects(rest.observe("probe", "delete"));
});

void test("credentials never allow an empty token or account", () => {
  for (const env of [
    {},
    { CLOUDFLARE_API_TOKEN: " ", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
    { CLOUDFLARE_API_TOKEN: "test", CLOUDFLARE_ACCOUNT_ID: "" },
  ]) {
    assert.equal(credentialsSchema.safeParse(env).success, false);
  }
});

void test("REST recovery paginates and deletes only old probe keys", async () => {
  const requests: string[] = [];
  const rest = stagingR2Rest(
    { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "test" },
    "test",
    (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(`${init?.method} ${url.pathname}${url.search}`);
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (!url.pathname.endsWith("/objects"))
        return Promise.resolve(new Response(null, { status: 404 }));
      const second = url.searchParams.has("cursor");
      return Promise.resolve(
        Response.json({
          success: true,
          result: second
            ? [{ key: "checks/r2-create-only/recent", last_modified: "2026-11-15T01:59:00Z" }]
            : [{ key: "checks/r2-create-only/old", last_modified: "2026-11-15T00:00:00Z" }],
          result_info: { is_truncated: !second, ...(second ? {} : { cursor: "next" }) },
        }),
      );
    },
  );
  await rest.recover(Date.parse("2026-11-15T02:00:00Z"));
  assert.equal(requests.filter((item) => item.startsWith("DELETE")).length, 1);
  assert(requests.some((item) => item.includes("cursor=next")));
  assert(
    requests.some(
      (item) => item.startsWith("DELETE") && item.endsWith("checks%2Fr2-create-only%2Fold"),
    ),
  );
});

void test("CLI rejects missing credentials before accessing Cloudflare", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new NodeURL("main.ts", import.meta.url))],
    {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ZodError/u);
  assert.equal(result.stdout, "");
});

void test("REST recovery accepts an empty page without pagination metadata", async () => {
  const rest = stagingR2Rest(
    { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "test" },
    "test",
    () => Promise.resolve(Response.json({ success: true, result: [] })),
  );
  await rest.recover();
});
