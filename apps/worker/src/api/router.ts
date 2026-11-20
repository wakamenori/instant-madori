import type { AuthenticatedUser } from "../owner.ts";
import { z } from "zod";
import type { LogFields } from "../log.ts";
import type { ServiceDeps } from "../services/deps.ts";
import type { HttpMethod, RoutePath } from "./http.ts";

/** What an authenticated route handler receives. */
export interface RouteContext {
  traceId: string;
  request: Request;
  url: URL;
  deps: ServiceDeps;
  user: AuthenticatedUser;
  /** Path parameters, already validated as UUIDs. */
  params: Record<string, string>;
  /** Adds fields to this request's log line (IDs only, never content). */
  log: LogFields;
}

type Method = Extract<HttpMethod, "GET" | "POST" | "PATCH">;

export interface Route {
  method: Method;
  /** Path template; `:name` segments are UUID parameters. */
  path: RoutePath;
  handle(context: RouteContext): Promise<Response>;
}

export type RouteMatch =
  | { kind: "matched"; route: Route; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: Method[] }
  | { kind: "not_found" };

const uuidSchema = z.uuid();

function matchPath(template: string, pathname: string): Record<string, string> | null {
  const expected = template.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] ?? "";
    if (segment.startsWith(":")) {
      // A malformed ID cannot name any resource, so it is "not found", not a bad request.
      if (!uuidSchema.safeParse(value).success) return null;
      params[segment.slice(1)] = value.toLowerCase();
    } else if (segment !== value) {
      return null;
    }
  }
  return params;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): RouteMatch {
  const allow: Method[] = [];
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (!params) continue;
    if (route.method === method) return { kind: "matched", route, params };
    allow.push(route.method);
  }
  return allow.length > 0 ? { kind: "method_not_allowed", allow } : { kind: "not_found" };
}

/** Reads a path parameter that the route template guarantees. */
export function param(context: RouteContext, name: string): string {
  const value = context.params[name];
  if (value === undefined) throw new Error(`Route has no parameter ${name}`);
  return value;
}
