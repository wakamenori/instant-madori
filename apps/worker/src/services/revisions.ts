import { nameSchema } from "@madori/contracts";
import type { Revision } from "@madori/contracts";
import type { OwnerId } from "../owner.ts";
import type { PatternState, RevisionPage } from "../storage/revisions.ts";
import type { ServiceDeps, StoreDeps } from "./deps.ts";

export type CommitOutcome =
  | { kind: "committed"; revision: Revision }
  | { kind: "not_found" }
  | { kind: "base_mismatch" }
  | { kind: "invalid_name" };

export async function commitRevision(
  {
    store,
    runtime,
  }: StoreDeps<"revisions", "commit"> &
    StoreDeps<"patterns", "get"> &
    StoreDeps<"snapshots", "write"> &
    Pick<ServiceDeps, "runtime">,
  input: {
    ownerId: OwnerId;
    patternId: string;
    baseRevisionId: string | null;
    name: string;
    display: Uint8Array<ArrayBuffer>;
  },
): Promise<CommitOutcome> {
  // Reads validate rows with the shared schema, so an unchecked name would commit a
  // revision that makes every later read of the pattern fail.
  const name = nameSchema.safeParse(input.name);
  if (!name.success) return { kind: "invalid_name" };
  const snapshot = await store.snapshots.write({
    id: runtime.newId(),
    ownerId: input.ownerId,
    now: runtime.now(),
    display: input.display,
  });
  const result = await store.revisions.commit({
    id: runtime.newId(),
    patternId: input.patternId,
    name: name.data,
    baseRevisionId: input.baseRevisionId,
    snapshot,
  });
  if (result.kind === "committed") return result;
  const pattern = await store.patterns.get({ ownerId: input.ownerId, patternId: input.patternId });
  return { kind: pattern ? "base_mismatch" : "not_found" };
}

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
  { store }: StoreDeps<"revisions", "snapshot"> & StoreDeps<"snapshots", "display">,
  scope: { ownerId: OwnerId; revisionId: string },
): Promise<RevisionViewOutcome> {
  const snapshot = await store.revisions.snapshot(scope);
  if (snapshot === null) return { kind: "not_found" };
  return { kind: "found", artifact: await store.snapshots.display(snapshot) };
}
