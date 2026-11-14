import type { OwnerId } from "../owner.ts";
import { jsonRows } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { patternSchema, projectSchema } from "@madori/contracts";
import type { Pattern, Project } from "@madori/contracts";
import { z } from "zod";
import { insertPatternStatements, patternJson } from "./patterns.ts";
import type { NewPattern } from "./patterns.ts";
import { createOnceStatements, mapOnce, runOnce, updateOnceStatements } from "./requests.ts";
import type { Once, RequestKey } from "./requests.ts";

/**
 * The single mapping from a `projects` row to `Project`. `t` is the table name or alias.
 * `fields` replaces columns with SQL expressions, to describe a row as it will be after an
 * update; their `?` placeholders appear in the order name, version, updatedAt.
 */
function projectJson(
  t: string,
  fields: { name?: string; version?: string; updatedAt?: string } = {},
) {
  return `json_object('id', ${t}.id,
    'name', ${fields.name ?? `${t}.name`}, 'version', ${fields.version ?? `${t}.version`},
    'createdAt', ${t}.created_at, 'updatedAt', ${fields.updatedAt ?? `${t}.updated_at`})`;
}

/** Position in the newest-first project list: the last project of the previous page. */
export interface ProjectPosition {
  createdAt: string;
  id: string;
}

export interface ProjectPage {
  projects: Project[];
  /** Null on the last page. */
  next: ProjectPosition | null;
}

/**
 * Lists projects newest first by creation time, which never changes, so pages stay stable
 * while projects are renamed. One extra row tells whether another page exists.
 */
export async function listProjects(
  db: D1,
  query: { ownerId: OwnerId; after: ProjectPosition | null; limit: number },
): Promise<ProjectPage> {
  const after = query.after;
  const statement = after
    ? {
        sql: `SELECT ${projectJson("t")} AS json FROM projects t
           WHERE t.owner_id = ? AND (t.created_at, t.id) < (?, ?)
           ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
        bindings: [query.ownerId, after.createdAt, after.id, query.limit + 1],
      }
    : {
        sql: `SELECT ${projectJson("t")} AS json FROM projects t
           WHERE t.owner_id = ?
           ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
        bindings: [query.ownerId, query.limit + 1],
      };
  const rows = await db.all(jsonRows(statement, projectSchema, "project"));
  const projects = rows.slice(0, query.limit);
  const last = projects.at(-1);
  return {
    projects,
    next: rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

export async function getProject(
  db: D1,
  scope: { ownerId: OwnerId; projectId: string },
): Promise<Project | null> {
  return db.first(
    jsonRows(
      {
        sql: `SELECT ${projectJson("t")} AS json FROM projects t WHERE t.owner_id = ? AND t.id = ?`,
        bindings: [scope.ownerId, scope.projectId],
      },
      projectSchema,
      "project",
    ),
  );
}

const createdProjectSchema = z.object({ project: projectSchema, pattern: patternSchema });

export interface NewProject {
  id: string;
  name: string;
  now: string;
  firstPattern: Omit<NewPattern, "projectId" | "now">;
}

/** Creates a project and its first pattern once per request. */
export async function createProjectOnce(
  db: D1,
  key: RequestKey,
  project: NewProject,
): Promise<Once<{ project: Project; pattern: Pattern }>> {
  const pattern: NewPattern = {
    ...project.firstPattern,
    projectId: project.id,
    now: project.now,
  };
  const insertProject = {
    sql: `INSERT INTO projects
         (id, owner_id, name, version, next_pattern_number, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, ?, ?)`,
    bindings: [project.id, key.ownerId, project.name, project.now, project.now],
  };
  const batch = createOnceStatements(key, project.now, {
    statements: [insertProject, ...insertPatternStatements(key.ownerId, pattern)],
    table: "patterns",
    id: pattern.id,
    result: {
      sql: `SELECT json_object('project', ${projectJson("p")}, 'pattern', ${patternJson("t")})
            FROM projects p JOIN patterns t ON t.project_id = p.id
            WHERE t.id = ?`,
      bindings: [pattern.id],
    },
  });
  return runOnce(db, createdProjectSchema, batch);
}

export interface ProjectRename {
  projectId: string;
  expectedVersion: number;
  name: string;
  now: string;
}

const projectResultSchema = z.object({ project: projectSchema });

/** Renames once per request if the version matches. `not_applied`: missing, foreign or stale. */
export async function renameProjectOnce(
  db: D1,
  key: RequestKey,
  rename: ProjectRename,
): Promise<Once<Project>> {
  const batch = updateOnceStatements(key, rename.now, {
    table: "projects",
    set: {
      sql: "name = ?, version = version + 1, updated_at = ?",
      bindings: [rename.name, rename.now],
    },
    where: {
      sql: "id = ? AND owner_id = ? AND version = ?",
      bindings: [rename.projectId, key.ownerId, rename.expectedVersion],
    },
    result: {
      sql: `SELECT json_object('project',
              ${projectJson("t", { name: "?", version: "t.version + 1", updatedAt: "?" })})
            FROM projects t WHERE t.id = ?`,
      bindings: [rename.name, rename.now, rename.projectId],
    },
  });
  const once = await runOnce(db, projectResultSchema, batch);
  return mapOnce(once, ({ project }) => project);
}
