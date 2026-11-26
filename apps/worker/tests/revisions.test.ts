import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
      assert.equal(lastFinishedJob.number, 52);
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
