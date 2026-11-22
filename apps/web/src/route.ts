import { projectSchema } from "@madori/contracts";

declare const projectIdBrand: unique symbol;
export type ProjectId = string & { readonly [projectIdBrand]: true };

export type Route =
  { kind: "projects" } | { kind: "project"; projectId: ProjectId } | { kind: "not_found" };

export const projectsRoute = { kind: "projects" } as const;

export function projectRoute(projectId: ProjectId): Extract<Route, { kind: "project" }> {
  return { kind: "project", projectId };
}

const projectIdSchema = projectSchema.shape.id.transform(
  (value) => value.toLowerCase() as ProjectId,
);
export function parseProjectId(value: string): ProjectId {
  return projectIdSchema.parse(value);
}
export function parseRoute(pathname: string): Route {
  if (pathname === "/") return projectsRoute;
  const prefix = "/projects/";
  if (pathname.startsWith(prefix)) {
    const id = projectIdSchema.safeParse(pathname.slice(prefix.length));
    if (id.success) return projectRoute(id.data);
  }
  return { kind: "not_found" };
}
export function formatRoute(route: Exclude<Route, { kind: "not_found" }>): string {
  switch (route.kind) {
    case "projects":
      return "/";
    case "project":
      return `/projects/${route.projectId}`;
  }
}
