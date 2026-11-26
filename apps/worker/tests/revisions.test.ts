import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { test } from "node:test";
import {
  apiErrorSchema,
  createProjectResponseSchema,
  meResponseSchema,
  patternStateResponseSchema,
  revisionListResponseSchema,
  displayContentType,
} from "@madori/contracts";
import { newUser, startLocalWorker } from "./support/local-worker.ts";

import { revisionFixture } from "./revision-fixture.ts";

await test("Immutable revisions through local D1, R2 and public HTTP", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());
  const owner = newUser("revision-owner");
  const other = newUser("revision-other");
  const identify = async (as: typeof owner) => {
    const response = await worker.call("/api/me", { as });
    assert.equal(response.status, 200);
    return meResponseSchema.parse(await response.json()).user.id;
  };
  const ownerId = await identify(owner);
  await identify(other);
  const created = await worker.call("/api/projects", {
    method: "POST",
    as: owner,
    body: { requestId: crypto.randomUUID() },
  });
  assert.equal(created.status, 201);
  const { pattern } = createProjectResponseSchema.parse(await created.json());
  const statePath = `/api/patterns/${pattern.id}/state`;
  const listPath = `/api/patterns/${pattern.id}/revisions`;
  await t.test("a pattern starts with no current revision and an empty history", async () => {
    const response = await worker.call(statePath, { as: owner });
    assert.equal(response.status, 200);
    assert.deepEqual(patternStateResponseSchema.parse(await response.json()), {
      pattern,
      currentRevision: null,
      runningJob: null,
      queueHold: null,
      queuedJobs: [],
      lastFinishedJob: null,
    });
    const list = await worker.call(listPath, { as: owner });
    assert.equal(list.status, 200);
    assert.deepEqual(revisionListResponseSchema.parse(await list.json()), {
      revisions: [],
      nextCursor: null,
    });
  });
  const { revisions } = revisionListResponseSchema
    .omit({ nextCursor: true })
    .parse(await revisionFixture(worker, { kind: "commit", ownerId, patternId: pattern.id }));
  await t.test("once-only storage operations apply first and replay on a resend", async () => {
    assert.deepEqual(await revisionFixture(worker, { kind: "once", ownerId }), { ok: true });
  });
  const latest = revisions.at(-1);
  const first = revisions[0];
  assert(latest && first);
  await t.test(
    "state reads the latest revision and view returns the exact saved bytes",
    async () => {
      const state = await worker.call(statePath, { as: owner });
      assert.equal(state.status, 200);
      const { lastFinishedJob, ...current } = patternStateResponseSchema.parse(await state.json());
      assert.equal(lastFinishedJob?.state, "completed");
      assert(lastFinishedJob?.state === "completed");
      assert.deepEqual(lastFinishedJob.revision, latest);
      assert.equal(lastFinishedJob.number, 103);
      assert.deepEqual(current, {
        pattern,
        currentRevision: latest,
        runningJob: null,
        queueHold: null,
        queuedJobs: [],
      });
      for (const revision of [first, latest]) {
        const view = await worker.call(`/api/revisions/${revision.id}/view`, { as: owner });
        assert.equal(view.status, 200);
        assert.equal(view.headers.get("content-type"), displayContentType);
        assert.equal(view.headers.get("cache-control"), "no-store");
        assert.equal(view.headers.get("x-revision-id"), revision.id);
        assert.equal(view.headers.get("x-floor-plan-storeys"), "");
        assert.deepEqual(
          Buffer.from(await view.arrayBuffer()),
          await readFile(
            new URL(
              revision.id === first.id
                ? "../../../crates/display/tests/fixtures/v1-two-bodies.mdsp"
                : "../../../crates/display/tests/two-bodies.mdsp",
              import.meta.url,
            ),
          ),
        );
      }
    },
  );
  await t.test(
    "revision pages follow number descending with a stable cursor boundary",
    async () => {
      const response = await worker.call(listPath, { as: owner });
      assert.equal(response.status, 200);
      const page = revisionListResponseSchema.parse(await response.json());
      assert.deepEqual(page.revisions, [...revisions].reverse().slice(0, 50));
      assert.equal(page.revisions.length, 50);
      assert(page.nextCursor);
      assert.equal(Buffer.from(page.nextCursor, "base64url").toString(), "3");
      const next = await worker.call(`${listPath}?cursor=${encodeURIComponent(page.nextCursor)}`, {
        as: owner,
      });
      assert.equal(next.status, 200);
      assert.deepEqual(revisionListResponseSchema.parse(await next.json()), {
        revisions: [revisions[1], first],
        nextCursor: null,
      });
      for (const query of [
        "cursor=garbage",
        "cursor=MA",
        "cursor=LTE",
        "cursor=MS41",
        "cursor=bnVsbA",
        "cursor=MQ&cursor=Mg",
        "limit=2",
      ]) {
        const invalid = await worker.call(`${listPath}?${query}`, { as: owner });
        assert.equal(invalid.status, 400, query);
        assert.deepEqual(apiErrorSchema.parse(await invalid.json()), { error: "invalid_request" });
      }
    },
  );
  await t.test("all reads hide another owner's resources and missing ids", async () => {
    const missingId = crypto.randomUUID();
    for (const [path, as] of [
      [statePath, other],
      [listPath, other],
      [`/api/revisions/${first.id}/view`, other],
      [`/api/patterns/${missingId}/state`, owner],
      [`/api/patterns/${missingId}/revisions`, owner],
      [`/api/revisions/${missingId}/view`, owner],
    ] as const) {
      const response = await worker.call(path, { as });
      assert.equal(response.status, 404, path);
      assert.deepEqual(apiErrorSchema.parse(await response.json()), { error: "not_found" });
    }
    const forbiddenWrite = await worker.call(listPath, { method: "POST", as: owner, body: {} });
    assert.equal(forbiddenWrite.status, 405);
  });
  const project = await worker.call("/api/projects", {
    method: "POST",
    as: owner,
    body: { requestId: crypto.randomUUID() },
  });
  assert.equal(project.status, 201);
  const viewPattern = createProjectResponseSchema.parse(await project.json()).pattern;
  const floorPlans = [
    { storey: "s1", svg: '<svg xmlns="http://www.w3.org/2000/svg"><title>Ground</title></svg>' },
    { storey: "s2", svg: '<svg xmlns="http://www.w3.org/2000/svg"><title>Upper</title></svg>' },
  ];
  const { current, legacy } = z.object({ current: z.uuid(), legacy: z.uuid() }).parse(
    await revisionFixture(worker, {
      kind: "view",
      ownerId,
      patternId: viewPattern.id,
      floorPlans,
    }),
  );
  const planPath = `/api/revisions/${current}/floor-plan`;
  await t.test("the 3D view lists the same revision's SVGs in manifest order", async () => {
    for (const [revision, header, display] of [
      [current, "s1,s2", "../../../crates/display/tests/two-bodies.mdsp"],
      [legacy, "", "../../../crates/display/tests/fixtures/v1-two-bodies.mdsp"],
    ] as const) {
      const view = await worker.call(`/api/revisions/${revision}/view`, { as: owner });
      assert.equal(view.status, 200);
      assert.equal(view.headers.get("content-type"), displayContentType);
      assert.equal(view.headers.get("x-revision-id"), revision);
      assert.equal(view.headers.get("x-floor-plan-storeys"), header);
      assert.deepEqual(
        Buffer.from(await view.arrayBuffer()),
        await readFile(new URL(display, import.meta.url)),
      );
    }
    for (const { storey, svg } of floorPlans) {
      const plan = await worker.call(`${planPath}?storey=${storey}`, { as: owner });
      assert.equal(plan.status, 200);
      assert.equal(plan.headers.get("content-type"), "image/svg+xml");
      assert.equal(
        plan.headers.get("content-security-policy"),
        "default-src 'none'; frame-ancestors 'self'",
      );
      assert.equal(plan.headers.get("x-content-type-options"), "nosniff");
      assert.equal(plan.headers.get("cache-control"), "no-store");
      assert.equal(plan.headers.get("x-revision-id"), current);
      assert.equal(await plan.text(), svg);
    }
  });
  await t.test(
    "only the owner can retrieve artifacts present in the requested revision",
    async () => {
      for (const [path, as] of [
        [`/api/revisions/${legacy}/floor-plan?storey=s1`, owner],
        [`${planPath}?storey=s3`, owner],
        [`/api/revisions/${current}/view`, other],
        [`${planPath}?storey=s1`, other],
        [`/api/revisions/${crypto.randomUUID()}/floor-plan?storey=s1`, owner],
      ] as const) {
        const result = await worker.call(path, { as });
        assert.equal(result.status, 404, path);
        assert.deepEqual(await result.json(), { error: "not_found" });
      }
    },
  );
  await t.test("floor-plan reads require exactly one valid storey", async () => {
    for (const query of [
      "",
      "storey=",
      "storey=s1&storey=s2",
      "storey=s1&extra=1",
      "storey=a,b",
      `storey=${"a".repeat(65)}`,
    ]) {
      const result = await worker.call(`${planPath}?${query}`, { as: owner });
      assert.equal(result.status, 400, query);
      assert.deepEqual(await result.json(), { error: "invalid_request" });
    }
    const write = await worker.call(`${planPath}?storey=s1`, {
      as: owner,
      method: "POST",
      body: {},
    });
    assert.equal(write.status, 405);
  });
  await t.test(
    "altered and missing SVG objects fail integrity checks for their owner",
    async () => {
      for (const missing of [false, true]) {
        await revisionFixture(worker, {
          kind: "damage",
          ownerId,
          revisionId: current,
          target: "floor-plan",
          missing,
        });
        const result = await worker.call(`${planPath}?storey=s1`, { as: owner });
        assert.equal(result.status, 500);
        assert.deepEqual(await result.json(), { error: "internal_error" });
        const hidden = await worker.call(`${planPath}?storey=s1`, { as: other });
        assert.equal(hidden.status, 404);
        assert.deepEqual(await hidden.json(), { error: "not_found" });
      }
    },
  );
  await t.test("missing and corrupted manifest or display objects fail with 500", async () => {
    for (const [index, target, missing] of [
      [0, "display", false],
      [1, "manifest", false],
      [2, "display", true],
      [3, "manifest", true],
    ] as const) {
      const revision = revisions[index];
      assert(revision);
      await revisionFixture(worker, {
        kind: "damage",
        ownerId,
        revisionId: revision.id,
        target,
        missing,
      });
      const response = await worker.call(`/api/revisions/${revision.id}/view`, { as: owner });
      assert.equal(response.status, 500);
      assert.deepEqual(apiErrorSchema.parse(await response.json()), { error: "internal_error" });
      const hidden = await worker.call(`/api/revisions/${revision.id}/view`, { as: other });
      assert.equal(hidden.status, 404);
    }
  });
});
