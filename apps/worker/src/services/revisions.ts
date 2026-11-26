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

export type RevisionViewOutcome =
  | { kind: "found"; artifact: { bytes: Uint8Array<ArrayBuffer>; contentType: string } }
  | { kind: "not_found" };

export async function getRevisionView(
  { store }: StoreDeps<"revisions", "snapshot"> & StoreDeps<"snapshots", "open">,
  scope: { ownerId: OwnerId; revisionId: string },
): Promise<RevisionViewOutcome> {
  const snapshot = await store.revisions.snapshot(scope);
  if (snapshot === null) return { kind: "not_found" };
  const opened = await store.snapshots.open(snapshot);
  return {
    kind: "found",
    artifact: { bytes: await opened.display.read(), contentType: opened.display.contentType },
  };
}
