import {
  createProjectRequestSchema,
  projectListQuerySchema,
  renameRequestSchema,
} from "@madori/contracts";
import type {
  CreateProjectResponse,
  ProjectListResponse,
  ProjectResponse,
} from "@madori/contracts";
import { createProject, getProject, listProjects, renameProject } from "../services/projects.ts";
import { decodeProjectCursor, encodeProjectCursor } from "./cursor.ts";
import { ApiFailure, readJsonBody, readQuery } from "./http.ts";
import { param } from "./router.ts";
import type { Route } from "./router.ts";

export const projectRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/projects",
    async handle({ url, deps, user }) {
      const query = readQuery(url, projectListQuerySchema);
      const page = await listProjects(deps, {
        ownerId: user.id,
        after: query.cursor === undefined ? null : decodeProjectCursor(query.cursor),
      });
      return Response.json({
        projects: page.projects,
        nextCursor: page.next && encodeProjectCursor(page.next),
      } satisfies ProjectListResponse);
    },
  },
  {
    method: "POST",
    path: "/api/projects",
    async handle({ request, deps, user, log }) {
      const input = await readJsonBody(request, createProjectRequestSchema);
      log["requestId"] = input.requestId;
      const outcome = await createProject(deps, {
        ownerId: user.id,
        requestId: input.requestId,
        name: input.name,
      });
      switch (outcome.kind) {
        case "created":
          return Response.json(
            { project: outcome.project, pattern: outcome.pattern } satisfies CreateProjectResponse,
            { status: 201 },
          );
        case "request_id_reused":
          throw new ApiFailure("request_id_reused");
      }
    },
  },
  {
    method: "GET",
    path: "/api/projects/:projectId",
    async handle(context) {
      const outcome = await getProject(context.deps, {
        ownerId: context.user.id,
        projectId: param(context, "projectId"),
      });
      switch (outcome.kind) {
        case "found":
          return Response.json({ project: outcome.project } satisfies ProjectResponse);
        case "not_found":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
  {
    method: "PATCH",
    path: "/api/projects/:projectId",
    async handle(context) {
      const { request, deps, user, log } = context;
      const input = await readJsonBody(request, renameRequestSchema);
      log["requestId"] = input.requestId;
      const outcome = await renameProject(deps, {
        ownerId: user.id,
        requestId: input.requestId,
        projectId: param(context, "projectId"),
        version: input.version,
        name: input.name,
      });
      switch (outcome.kind) {
        case "renamed":
          return Response.json({ project: outcome.project } satisfies ProjectResponse);
        case "not_found":
        case "version_conflict":
        case "request_id_reused":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
];
