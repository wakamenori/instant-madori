import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  type FinishedJob,
  displayContentType,
  patternStateResponseSchema,
  revisionListResponseSchema,
} from "../../../packages/contracts/src/index.ts";

export interface Committed {
  id: string;
  number: number;
  name: string;
  baseRevisionId: string | null;
  createdAt: string;
  displaySha256: string;
}
export interface Snapshot {
  current: string | null;
  history: readonly Committed[];
  lastFinished: {
    jobId: string;
    state: FinishedJob["state"];
    revisionId: string | null;
  } | null;
  busy: { running: string | null; queued: readonly string[]; heldBy: string | null };
}
export type Delta = { adds: 0 } | { adds: 1; committedBy: string };

export async function readSnapshot(
  get: (path: string) => Promise<Response>,
  patternId: string,
): Promise<Snapshot> {
  const base = `/api/patterns/${patternId}`;
  const stateResponse = await get(base + "/state");
  assert.equal(stateResponse.status, 200, "read pattern state");
  const state = patternStateResponseSchema.parse(await stateResponse.json());
  assert.equal(state.pattern.id, patternId, "state belongs to the journey pattern");
  const history: Committed[] = [];
  const seenIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await get(
      base +
        "/revisions" +
        (cursor === null ? "" : "?" + new URLSearchParams({ cursor }).toString()),
    );
    assert.equal(response.status, 200, "read revision list");
    const page = revisionListResponseSchema.parse(await response.json());
    for (const { patternId: owner, ...revision } of page.revisions) {
      assert.equal(owner, patternId, "revision belongs to the journey pattern");
      assert(!seenIds.has(revision.id), "duplicate revision");
      seenIds.add(revision.id);
      const view = await get(`/api/revisions/${revision.id}/view`);
      assert.equal(view.status, 200, "read revision display");
      assert(
        view.headers.get("content-type") === displayContentType,
        "incorrect display content type",
      );
      assert(view.headers.get("x-revision-id") === revision.id, "incorrect display revision");
      const bytes = new Uint8Array(await view.arrayBuffer());
      assert(bytes.length > 0, "empty revision display");
      history.push({
        ...revision,
        displaySha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      assert(!cursors.has(cursor), "repeated revision cursor");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  const finished = state.lastFinishedJob;
  return {
    current: state.currentRevision?.id ?? null,
    history,
    lastFinished: finished && {
      jobId: finished.jobId,
      state: finished.state,
      revisionId: finished.state === "completed" ? finished.revision.id : null,
    },
    busy: {
      running: state.runningJob?.jobId ?? null,
      queued: state.queuedJobs.map((j) => j.jobId),
      heldBy: state.queueHold?.job.jobId ?? null,
    },
  };
}

export function judge(before: Snapshot, after: Snapshot, expected: Delta): string[] {
  const issues: string[] = [];
  const remaining = new Map(after.history.map((r) => [r.id, r]));
  for (const old of before.history) {
    const current = remaining.get(old.id);
    const label = `revision #${old.number} (id ${old.id})`;
    remaining.delete(old.id);
    if (!current) {
      issues.push(label + ": missing");
      continue;
    }
    if (old.displaySha256 !== current.displaySha256) issues.push(label + ": display changed");
    for (const field of ["number", "name", "baseRevisionId", "createdAt"] as const) {
      if (old[field] !== current[field]) issues.push(label + ": " + field + " changed");
    }
  }
  if (remaining.size !== expected.adds)
    issues.push(`added ${remaining.size} revisions, expected ${expected.adds}`);
  if (!expected.adds && after.current !== before.current) issues.push("current revision changed");
  if (expected.adds === 1 && remaining.size === 1) {
    for (const added of remaining.values()) {
      if (added.id !== after.current) issues.push("added revision is not current");
      if (added.baseRevisionId !== before.current) issues.push("incorrect base revision");
      if (added.number !== 1 + before.history.reduce((n, r) => Math.max(n, r.number), 0))
        issues.push("incorrect revision number");
      const job = after.lastFinished;
      if (
        job?.jobId !== expected.committedBy ||
        job.state !== "completed" ||
        job.revisionId !== added.id
      )
        issues.push("last finished job did not commit the added revision");
    }
  }
  if (after.busy.running || after.busy.heldBy || after.busy.queued.length)
    issues.push("pattern is not quiet");
  return issues;
}
