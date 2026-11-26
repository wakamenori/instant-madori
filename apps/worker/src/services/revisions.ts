import type { OwnerId } from "../owner.ts";
import type { PatternState, RevisionPage } from "../storage/revisions.ts";
import type { StoreDeps } from "./deps.ts";

export type PatternStateOutcome = { kind: "found"; state: PatternState } | { kind: "not_found" };

export async function getPatternState(
  { store }: StoreDeps<"revisions", "state">,
  scope: { ownerId: OwnerId; patternId: string },
): Promise<PatternStateOutcome> {
  const state = await store.revisions.state(scope);
  return state === null ? { kind: "not_found" } : { kind: "found", state };
}

const revisionPageSize = 50;

export type ListRevisionsOutcome = { kind: "listed"; page: RevisionPage } | { kind: "not_found" };

export async function listRevisions(
  { store }: StoreDeps<"revisions", "list">,
  query: { ownerId: OwnerId; patternId: string; after: number | null },
): Promise<ListRevisionsOutcome> {
  const page = await store.revisions.list({ ...query, limit: revisionPageSize });
  return page === null ? { kind: "not_found" } : { kind: "listed", page };
}

type Artifact = { bytes: Uint8Array<ArrayBuffer>; contentType: string };

export type RevisionViewOutcome =
  { kind: "found"; display: Artifact; storeys: readonly string[] } | { kind: "not_found" };

export async function getRevisionView(
  { store }: StoreDeps<"revisions", "snapshot"> & StoreDeps<"snapshots", "open">,
  scope: { ownerId: OwnerId; revisionId: string },
): Promise<RevisionViewOutcome> {
  const snapshot = await store.revisions.snapshot(scope);
  if (snapshot === null) return { kind: "not_found" };
  const opened = await store.snapshots.open(snapshot);
  return {
    kind: "found",
    storeys: opened.house?.floorPlans.map((plan) => plan.storey) ?? [],
    display: { bytes: await opened.display.read(), contentType: opened.display.contentType },
  };
}

export async function getFloorPlan(
  { store }: StoreDeps<"revisions", "snapshot"> & StoreDeps<"snapshots", "open">,
  { ownerId, revisionId, storey }: { ownerId: OwnerId; revisionId: string; storey: string },
): Promise<{ kind: "found"; artifact: Artifact } | { kind: "not_found" }> {
  const snapshot = await store.revisions.snapshot({ ownerId, revisionId });
  if (snapshot === null || snapshot.formatVersion === 1) return { kind: "not_found" };
  const opened = await store.snapshots.open(snapshot);
  const plan = opened.house?.floorPlans.find((plan) => plan.storey === storey);
  if (!plan) return { kind: "not_found" };
  return { kind: "found", artifact: { bytes: await plan.read(), contentType: plan.contentType } };
}
