import type { OwnerId } from "../owner.ts";
import type { Pattern, Project } from "@madori/contracts";
import type { ProjectPage, ProjectPosition } from "../storage/projects.ts";

// The api layer depends on services only; the page types are part of this service's surface.
export type { ProjectPage, ProjectPosition };
import { requestKey } from "./requests.ts";
import type { ServiceDeps, StoreDeps } from "./deps.ts";
import { defaultPatternNamePrefix } from "./patterns.ts";

const defaultProjectName = "新しい案件";
const projectPageSize = 50;

export function listProjects(
  { store }: StoreDeps<"projects", "list">,
  query: { ownerId: OwnerId; after: ProjectPosition | null },
): Promise<ProjectPage> {
  return store.projects.list({ ...query, limit: projectPageSize });
}

export type GetProjectOutcome = { kind: "found"; project: Project } | { kind: "not_found" };

export async function getProject(
  { store }: StoreDeps<"projects", "get">,
  scope: { ownerId: OwnerId; projectId: string },
): Promise<GetProjectOutcome> {
  const project = await store.projects.get(scope);
  return project === null ? { kind: "not_found" } : { kind: "found", project };
}

export type CreateProjectOutcome =
  { kind: "created"; project: Project; pattern: Pattern } | { kind: "request_id_reused" };

/** Creates a project with its first pattern, so a new consultation can start at once. */
export async function createProject(
  { store, runtime }: StoreDeps<"projects", "createOnce"> & Pick<ServiceDeps, "runtime">,
  input: { ownerId: OwnerId; requestId: string; name: string | undefined },
): Promise<CreateProjectOutcome> {
  const key = await requestKey(input.ownerId, input.requestId, "project.create", {
    name: input.name,
  });
  const once = await store.projects.createOnce(key, {
    id: runtime.newId(),
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
  { store, runtime }: StoreDeps<"projects", "renameOnce" | "get"> & Pick<ServiceDeps, "runtime">,
  input: { ownerId: OwnerId; requestId: string; projectId: string; version: number; name: string },
): Promise<RenameProjectOutcome> {
  const key = await requestKey(input.ownerId, input.requestId, "project.rename", {
    projectId: input.projectId,
    version: input.version,
    name: input.name,
  });
  const once = await store.projects.renameOnce(key, {
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
      const current = await store.projects.get({
        ownerId: input.ownerId,
        projectId: input.projectId,
      });
      return { kind: current ? "version_conflict" : "not_found" };
    }
  }
}
