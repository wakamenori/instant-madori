import assert from "node:assert/strict";
import { test } from "node:test";
import { deployStaging } from "./deploy.ts";
const ref = "measurement/lite";
const sha = "a".repeat(40);
const request = { ref, instance: "lite" };
const date = "2026-11-20T00:00:00Z";
const run = {
  databaseId: 2,
  headSha: sha,
  headBranch: ref,
  event: "workflow_dispatch",
  status: "queued",
  conclusion: "",
  createdAt: date,
  url: "https://github.com/example/project/actions/runs/2",
};
const completed = {
  headSha: sha,
  url: run.url,
  status: "completed",
  conclusion: "success",
  startedAt: date,
  updatedAt: "2026-11-20T00:05:00Z",
};
const config = JSON.stringify({
  env: { staging: { vars: { GEOMETRY_INSTANCE_TYPE: "lite", GEOMETRY_IDLE_TIMEOUT_MS: "60000" } } },
});
const preflight = [JSON.stringify({ object: { sha } }), config] as const;
function scenario(responses: string[]) {
  const calls: string[][] = [];
  let at = 0;
  const result = deployStaging(request, {
    gh: (args) => {
      calls.push([...args]);
      const response = responses.shift();
      assert.ok(response !== undefined, "unexpected gh call");
      return Promise.resolve(response);
    },
    now: () => at,
    sleep: (ms) => {
      at += ms;
      return Promise.resolve();
    },
    report: () => {},
  });
  return { calls, result };
}
await test("dispatches the checked ref and follows only the new run", async () => {
  const old = { ...run, databaseId: 1, status: "completed" };
  const { result, calls } = scenario([
    ...preflight,
    JSON.stringify([old]),
    "",
    "[]",
    JSON.stringify([old, run]),
    JSON.stringify({ ...completed, status: "in_progress", conclusion: "" }),
    JSON.stringify(completed),
  ]);
  assert.deepEqual(await result, {
    ref,
    sha,
    instanceType: "lite",
    idleTimeoutMs: 60000,
    run: run.url,
    startedAt: date,
    completedAt: completed.updatedAt,
  });
  assert.deepEqual(calls[0], ["api", `repos/{owner}/{repo}/git/ref/heads/${ref}`]);
  assert.ok(calls[1]?.at(-1)?.endsWith(`?ref=${sha}`));
  assert.deepEqual(calls[3], ["workflow", "run", "deploy-staging.yml", "--ref", ref]);
  assert.deepEqual(calls.at(-1)?.slice(0, 3), ["run", "view", "2"]);
});
await test("refuses mismatched instance, pending deploy and malformed JSON before dispatch", async () => {
  for (const [responses, error] of [
    [[preflight[0], config.replace("lite", "standard-1")], /sets standard-1/u],
    [[...preflight, JSON.stringify([{ ...run, status: "pending" }])], /pending/u],
    [[...preflight, "{}"], /Invalid gh JSON/u],
  ] as const) {
    const { result, calls } = scenario([...responses]);
    await assert.rejects(result, error);
    assert.ok(calls.every(([command]) => command !== "workflow"));
  }
});
await test("fails if the dispatch never appears, is ambiguous, moves or is cancelled", async () => {
  const dispatched = [...preflight, "[]", ""];
  await assert.rejects(
    scenario([...dispatched, ...Array.from({ length: 24 }, () => "[]")]).result,
    /did not appear/u,
  );
  await assert.rejects(
    scenario([...dispatched, JSON.stringify([run, { ...run, databaseId: 3 }])]).result,
    /ambiguous/u,
  );
  await assert.rejects(
    scenario([...dispatched, JSON.stringify([{ ...run, headSha: "b".repeat(40) }])]).result,
    /moved/u,
  );
  await assert.rejects(
    scenario([
      ...dispatched,
      JSON.stringify([run]),
      JSON.stringify({ ...completed, conclusion: "cancelled" }),
    ]).result,
    /was cancelled/u,
  );
});
