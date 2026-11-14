import { nameSchema } from "@madori/contracts";
import type { Revision } from "@madori/contracts";
import { getPattern } from "../storage/patterns.ts";
import type { PatternState, RevisionPage } from "../storage/revisions.ts";
import {
  commitRevision as commitRow,
  getPatternState as getStateRows,
  getRevisionSnapshot,
  listRevisions as listRows,
} from "../storage/revisions.ts";
import { readSnapshotDisplay, writeSnapshot } from "../storage/snapshots.ts";
import type { ServiceDeps } from "./deps.ts";

export type CommitOutcome =
  | { kind: "committed"; revision: Revision }
  | { kind: "not_found" }
  | { kind: "base_mismatch" }
  | { kind: "invalid_name" };

export async function commitRevision(
  { db, bucket, runtime }: Pick<ServiceDeps, "db" | "bucket" | "runtime">,
  input: {
    ownerId: string;
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
  const snapshot = await writeSnapshot(bucket, {
    id: runtime.newId(),
    ownerId: input.ownerId,
    now: runtime.now(),
    display: input.display,
  });
  const result = await commitRow(db, {
    id: runtime.newId(),
    ownerId: input.ownerId,
    patternId: input.patternId,
    name: name.data,
    baseRevisionId: input.baseRevisionId,
    snapshot,
  });
  if (result.kind === "committed") return result;
  const pattern = await getPattern(db, { ownerId: input.ownerId, patternId: input.patternId });
  return { kind: pattern ? "base_mismatch" : "not_found" };
}

export type PatternStateOutcome = { kind: "found"; state: PatternState } | { kind: "not_found" };

export async function getPatternState(
  { db }: ServiceDeps,
  scope: { ownerId: string; patternId: string },
): Promise<PatternStateOutcome> {
  const state = await getStateRows(db, scope);
  return state === null ? { kind: "not_found" } : { kind: "found", state };
}

const revisionPageSize = 50;

export type ListRevisionsOutcome = { kind: "listed"; page: RevisionPage } | { kind: "not_found" };

export async function listRevisions(
  { db }: ServiceDeps,
  query: { ownerId: string; patternId: string; after: number | null },
): Promise<ListRevisionsOutcome> {
  const page = await listRows(db, { ...query, limit: revisionPageSize });
  return page === null ? { kind: "not_found" } : { kind: "listed", page };
}

export type RevisionViewOutcome =
  | { kind: "found"; artifact: { bytes: Uint8Array<ArrayBuffer>; contentType: string } }
  | { kind: "not_found" };

export async function getRevisionView(
  { db, bucket }: ServiceDeps,
  scope: { ownerId: string; revisionId: string },
): Promise<RevisionViewOutcome> {
  const snapshot = await getRevisionSnapshot(db, scope);
  if (snapshot === null) return { kind: "not_found" };
  return { kind: "found", artifact: await readSnapshotDisplay(bucket, snapshot) };
}
