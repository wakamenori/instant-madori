import assert from "node:assert/strict";
import { test } from "node:test";
import { workerHealthSchema } from "@madori/contracts";
import worker from "../src/index.ts";

const apiEnvironment: Env = {
  get ASSETS(): Fetcher {
    throw new Error("API requests must not fall through to the SPA asset binding");
  },
};

await test("the health response satisfies the contract consumed by the web app", async () => {
  const response = await worker.fetch(
    new Request("https://test.invalid/api/health"),
    apiEnvironment,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const payload: unknown = await response.json();
  assert.equal(workerHealthSchema.safeParse(payload).success, true);
});

await test("unsupported health methods return 405 and advertise GET", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
    const response = await worker.fetch(
      new Request("https://test.invalid/api/health", { method }),
      apiEnvironment,
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET");
  }
});

await test("unknown API routes return JSON even when the browser accepts HTML", async () => {
  const response = await worker.fetch(
    new Request("https://test.invalid/api/missing", {
      headers: { accept: "text/html" },
    }),
    apiEnvironment,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});
