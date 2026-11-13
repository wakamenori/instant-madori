import type { Pattern, Project } from "@madori/contracts";
import {
  createProjectOnce,
  getProject,
  listProjects as listProjectRows,
  renameProjectOnce,
} from "../storage/projects.ts";
import type { ProjectPage, ProjectPosition } from "../storage/projects.ts";

// The api layer depends on services only; the page types are part of this service's surface.
export type { ProjectPage, ProjectPosition };
import { requestKey } from "./requests.ts";
import type { ServiceDeps } from "./deps.ts";
import { defaultPatternNamePrefix } from "./patterns.ts";

const defaultProjectName = "新しい案件";
const projectPageSize = 50;

export function listProjects(
  { db }: ServiceDeps,
  query: { ownerId: string; after: ProjectPosition | null },
): Promise<ProjectPage> {
  return listProjectRows(db, { ...query, limit: projectPageSize });
}

export type CreateProjectOutcome =
  { kind: "created"; project: Project; pattern: Pattern } | { kind: "request_id_reused" };

/** Creates a project with its first pattern, so a new consultation can start at once. */
export async function createProject(
  { db, runtime }: ServiceDeps,
  input: { ownerId: string; requestId: string; name: string | undefined },
): Promise<CreateProjectOutcome> {
  const key = await requestKey(input.ownerId, input.requestId, "project.create", {
    name: input.name,
  });
  const once = await createProjectOnce(db, key, {
    id: runtime.newId(),
    ownerId: input.ownerId,
    name: input.name ?? defaultProjectName,
    now: runtime.now(),
    firstPattern: { id: runtime.newId(), name: null, defaultNamePrefix: defaultPatternNamePrefix },
  });
  switch (once.kind) {
    case "applied":
    case "replayed":
      return { kind: "created", ...once.result };
    case "request_id_reused":
      return once;
    case "not_applied":
      // The insert has no condition; only a constraint error could stop it, and that throws.
      throw new Error("Project creation wrote nothing");
  }
}

export type RenameProjectOutcome =
  | { kind: "renamed"; project: Project }
  | { kind: "not_found" }
  | { kind: "version_conflict" }
  | { kind: "request_id_reused" };

export async function renameProject(
  { db, runtime }: ServiceDeps,
  input: { ownerId: string; requestId: string; projectId: string; version: number; name: string },
): Promise<RenameProjectOutcome> {
  const key = await requestKey(input.ownerId, input.requestId, "project.rename", {
    projectId: input.projectId,
    version: input.version,
    name: input.name,
  });
  const once = await renameProjectOnce(db, key, {
    ownerId: input.ownerId,
    projectId: input.projectId,
    expectedVersion: input.version,
    name: input.name,
    now: runtime.now(),
  });
  switch (once.kind) {
    case "applied":
    case "replayed":
      return { kind: "renamed", project: once.result };
    case "request_id_reused":
      return once;
    case "not_applied": {
      // The condition is decided in SQL; this read only explains why it did not hold.
      const current = await getProject(db, { ownerId: input.ownerId, projectId: input.projectId });
      return { kind: current ? "version_conflict" : "not_found" };
    }
  }
}
