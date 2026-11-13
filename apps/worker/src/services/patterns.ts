import type { Pattern } from "@madori/contracts";
import {
  createPatternOnce,
  getPattern,
  listProjectPatterns,
  renamePatternOnce,
} from "../storage/patterns.ts";
import { requestKey } from "./requests.ts";
import type { ServiceDeps } from "./deps.ts";

/** Default pattern names are this prefix plus the project's next pattern number. */
export const defaultPatternNamePrefix = "パターン";

export type ListPatternsOutcome = { kind: "listed"; patterns: Pattern[] } | { kind: "not_found" };

export async function listPatterns(
  { db }: ServiceDeps,
  scope: { ownerId: string; projectId: string },
): Promise<ListPatternsOutcome> {
  const patterns = await listProjectPatterns(db, scope);
  return patterns === null ? { kind: "not_found" } : { kind: "listed", patterns };
}

export type CreatePatternOutcome =
  { kind: "created"; pattern: Pattern } | { kind: "not_found" } | { kind: "request_id_reused" };

export async function createPattern(
  { db, runtime }: ServiceDeps,
  input: { ownerId: string; requestId: string; projectId: string; name: string | undefined },
): Promise<CreatePatternOutcome> {
  const key = await requestKey(input.ownerId, input.requestId, "pattern.create", {
    projectId: input.projectId,
    name: input.name,
  });
  const once = await createPatternOnce(db, key, {
    id: runtime.newId(),
    projectId: input.projectId,
    ownerId: input.ownerId,
    name: input.name ?? null,
    defaultNamePrefix: defaultPatternNamePrefix,
    now: runtime.now(),
  });
  switch (once.kind) {
    case "applied":
    case "replayed":
      return { kind: "created", pattern: once.result };
    case "request_id_reused":
      return once;
    case "not_applied":
      // The only condition is that the project exists and belongs to the caller.
      return { kind: "not_found" };
  }
}

export type RenamePatternOutcome =
  | { kind: "renamed"; pattern: Pattern }
  | { kind: "not_found" }
  | { kind: "version_conflict" }
  | { kind: "request_id_reused" };

export async function renamePattern(
  { db, runtime }: ServiceDeps,
  input: { ownerId: string; requestId: string; patternId: string; version: number; name: string },
): Promise<RenamePatternOutcome> {
  const key = await requestKey(input.ownerId, input.requestId, "pattern.rename", {
    patternId: input.patternId,
    version: input.version,
    name: input.name,
  });
  const once = await renamePatternOnce(db, key, {
    ownerId: input.ownerId,
    patternId: input.patternId,
    expectedVersion: input.version,
    name: input.name,
    now: runtime.now(),
  });
  switch (once.kind) {
    case "applied":
    case "replayed":
      return { kind: "renamed", pattern: once.result };
    case "request_id_reused":
      return once;
    case "not_applied": {
      const current = await getPattern(db, { ownerId: input.ownerId, patternId: input.patternId });
      return { kind: current ? "version_conflict" : "not_found" };
    }
  }
}
