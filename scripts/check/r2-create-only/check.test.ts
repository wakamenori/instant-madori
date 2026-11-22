import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { test, type TestContext } from "node:test";
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

const credentials = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "token-never-logged",
};
const listPath = "/r2/buckets/test/objects?prefix=checks%2Fr2-create-only%2F&per_page=1000";
const emptyPage = () => Response.json({ success: true, result: [] });

type Reply = Response | Error | (() => Response);

function cloudflare(
  t: TestContext,
  replies: Partial<Record<"GET" | "DELETE", Reply[]>>,
  budgetSpent = false,
) {
  const sent: string[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  const rest = stagingR2Rest(
    credentials,
    "test",
    (_input, init) => {
      const method = init?.method === "DELETE" ? "DELETE" : "GET";
      sent.push(method);
      const reply = replies[method]?.shift() ?? emptyPage;
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve(typeof reply === "function" ? reply() : reply);
    },
    (ms) => {
      waits.push(ms);
      return budgetSpent
        ? Promise.reject(new DOMException("aborted", "AbortError"))
        : Promise.resolve();
    },
  );
  const retries = () => logs.filter((line) => line.includes("REST retry"));
  return { rest, sent, waits, logs, retries };
}

void test("REST read retries one transient 500 and logs one line", async (t) => {
  const fake = cloudflare(t, { GET: [new Response(null, { status: 500 })] });
  await fake.rest.recover();
  assert.deepEqual(fake.sent, ["GET", "GET"]);
  assert.equal(fake.retries().length, 1);
  const [line] = fake.retries();
  assert(line?.includes(`REST ${listPath} returned 500`));
  for (const secret of [credentials.CLOUDFLARE_API_TOKEN, credentials.CLOUDFLARE_ACCOUNT_ID])
    assert(fake.logs.every((logged) => !logged.includes(secret)));
});

void test("REST read past the retry bound fails with the same assert as before", async (t) => {
  const fake = cloudflare(t, {
    GET: Array.from({ length: 4 }, () => new Response(null, { status: 500 })),
  });
  await assert.rejects(fake.rest.recover(), {
    name: "AssertionError",
    actual: 500,
    expected: 200,
    message:
      /^REST \/r2\/buckets\/test\/objects\?prefix=checks%2Fr2-create-only%2F&per_page=1000 must succeed/u,
  });
  assert.deepEqual(fake.sent, ["GET", "GET", "GET"]);
  assert.deepEqual(fake.waits, [1000, 2000]);
});

void test("REST read fails at once on 403, a wrong body, a timeout, or invalid headers", async (t) => {
  for (const [reply, expected] of [
    [new Response(null, { status: 403 }), { name: "AssertionError", actual: 403 }],
    [Response.json({ success: true, result: "not a list" }), { name: "ZodError" }],
    [
      new TypeError("Headers.append: invalid header value"),
      { name: "TypeError", message: "Headers.append: invalid header value" },
    ],
    [new DOMException("timed out", "TimeoutError"), { name: "TimeoutError" }],
  ] as const) {
    const fake = cloudflare(t, { GET: [reply, emptyPage()] });
    await assert.rejects(fake.rest.recover(), expected);
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.retries().length, 0);
  }
});

void test("REST read retries a network failure", async (t) => {
  const fake = cloudflare(t, { GET: [new TypeError("fetch failed")] });
  assert.deepEqual(await fake.rest.scripts(), []);
  assert.match(fake.retries()[0] ?? "", /REST \/workers\/scripts failed with a network error/u);
  assert.equal(fake.retries().length, 1);
});

void test("REST read stops retrying when its 30 s budget runs out", async (t) => {
  const fake = cloudflare(t, { GET: [new Response(null, { status: 503 })] }, true);
  await assert.rejects(fake.rest.recover(), { name: "AssertionError", actual: 503, expected: 200 });
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.retries().length, 0);
});

void test("REST recovery never retries a DELETE", async (t) => {
  const fake = cloudflare(t, {
    GET: [
      Response.json({
        success: true,
        result: [{ key: "checks/r2-create-only/old", last_modified: "2026-11-15T00:00:00Z" }],
      }),
    ],
    DELETE: [new Response(null, { status: 503 }), new Response(null, { status: 204 })],
  });
  await assert.rejects(
    fake.rest.recover(Date.parse("2026-11-15T02:00:00Z")),
    /REST recovery delete must succeed \(503\)/u,
  );
  assert.equal(fake.sent.filter((method) => method === "DELETE").length, 1);
});

void test("REST observation retries a 5xx and still judges the object it reads", async (t) => {
  const wrong = cloudflare(t, {
    GET: [new Response(null, { status: 502 }), new Response(new Uint8Array([8]))],
  });
  await assert.rejects(wrong.rest.observe("probe", "reject"), {
    message: /REST must read original bytes/u,
  });
  const deleted = cloudflare(t, {
    GET: [new Response(null, { status: 502 }), new Response(null, { status: 404 })],
  });
  await deleted.rest.observe("probe", "delete");
  const kept = cloudflare(t, {
    GET: [new Response(null, { status: 502 }), new Response(original)],
  });
  await assert.rejects(kept.rest.observe("probe", "delete"), { actual: 200, expected: 404 });
});

void test("REST read reports the previous 500 when the retry times out", async (t) => {
  const fake = cloudflare(t, {
    GET: [new Response(null, { status: 500 }), new DOMException("timed out", "TimeoutError")],
  });
  await assert.rejects(fake.rest.recover(), { name: "AssertionError", actual: 500, expected: 200 });
  assert.deepEqual(fake.sent, ["GET", "GET"]);
});

void test("REST read retries a 500 even when its response stream has errored", async (t) => {
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
  const fake = cloudflare(t, { GET: [new Response(stream, { status: 500 })] });
  await fake.rest.recover();
  assert.deepEqual(fake.sent, ["GET", "GET"]);
  assert.equal(fake.retries().length, 1);
});
