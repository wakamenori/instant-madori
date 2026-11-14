import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { repositoryRoot } from "../shared/repository.ts";
import { smokeStaging, stagingOrigin } from "./staging-smoke.ts";

const token = { clientId: "id", clientSecret: "secret" };
type Answers = { anonymous: number; health: [number, unknown]; me: [number, unknown] };
const healthy: Answers = {
  anonymous: 302,
  health: [200, { status: "ok", service: "worker" }],
  me: [403, { error: "forbidden" }],
};

function fakeFetch(answers: Answers): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const json = (status: number, body: unknown) => Response.json(body, { status });
    if (!headers.has("CF-Access-Client-Id"))
      return Promise.resolve(new Response(null, { status: answers.anonymous }));
    return Promise.resolve(
      url.pathname === "/api/health" ? json(...answers.health) : json(...answers.me),
    );
  };
}

void test("a correctly protected staging Worker passes", async () => {
  await smokeStaging("https://staging.test", token, fakeFetch(healthy));
});

void test("an open Worker, a broken health check or a wrong audience fails", async () => {
  for (const broken of [
    { ...healthy, anonymous: 200 },
    { ...healthy, health: [500, { error: "internal" }] },
    { ...healthy, me: [401, { error: "unauthenticated" }] },
    { ...healthy, me: [200, { id: "user" }] },
  ] satisfies Answers[]) {
    await assert.rejects(smokeStaging("https://staging.test", token, fakeFetch(broken)));
  }
});

void test("the staging origin comes from the Worker configuration", () => {
  const origin = stagingOrigin(
    readFileSync(new URL("apps/worker/wrangler.jsonc", repositoryRoot), "utf8"),
  );
  assert.match(origin, /^https:\/\/[^,]+\.workers\.dev$/);
});
