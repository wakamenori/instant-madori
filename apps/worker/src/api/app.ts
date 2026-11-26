import type { WorkerHealth } from "@madori/contracts";
import { describeError, logEvent } from "../log.ts";
import type { LogFields } from "../log.ts";
import { serviceDeps } from "../compose.ts";
import type { Runtime } from "../services/deps.ts";
import { resolveUser } from "../services/users.ts";
import { verifyAccessToken } from "./access.ts";
import { loadConfig } from "./config.ts";
import { ApiFailure, errorResponse, parseHttpMethod } from "./http.ts";
import { assetRoute } from "./assets.ts";
import { conversationRoutes } from "./conversation.ts";
import { queueRoutes } from "./queue.ts";
import { jobRoutes } from "./jobs.ts";
import { meRoutes } from "./me.ts";
import { messageRoutes } from "./messages.ts";
import { patternRoutes } from "./patterns.ts";
import { pickRoute } from "./pick.ts";
import { projectRoutes } from "./projects.ts";
import { matchRoute } from "./router.ts";
import { revisionRoutes } from "./revisions.ts";

const routes = [
  assetRoute,
  ...meRoutes,
  ...queueRoutes,
  ...jobRoutes,
  ...messageRoutes,
  ...conversationRoutes,
  ...projectRoutes,
  ...patternRoutes,
  ...revisionRoutes,
  pickRoute,
];

/** A Cloudflare Ray ID: 16 hex digits and a data-center code, e.g. `230b030023ae2822-SJC`. */
const rayIdPattern = /^[0-9a-f]{16}-[A-Z]{3}$/;

/**
 * Handles every `/api/*` request. Order of checks: route → configuration → Access JWT →
 * Origin (non-GET) → internal user → handler. Every response is uncacheable and carries
 * a trace ID that also appears in the request's single log line.
 */
export async function handleApi(
  request: Request,
  url: URL,
  env: Env,
  runtime: Runtime,
): Promise<Response> {
  const started = Date.now();
  // Our own ID per request: Cloudflare's ray ID is not guaranteed to be unique and, outside
  // Cloudflare, is whatever the client sent. It is logged separately, and only when it has
  // the documented form, to match our line with Cloudflare's logs.
  const traceId = runtime.newTraceId();
  const rayId = request.headers.get("cf-ray") ?? "";
  const log: LogFields = {
    traceId,
    rayId: rayIdPattern.test(rayId) ? rayId : undefined,
    method: parseHttpMethod(request.method),
  };
  let response: Response;
  try {
    response = await dispatch(request, url, env, runtime, log, traceId);
  } catch (error) {
    if (error instanceof ApiFailure) {
      response = errorResponse(error.code, error.headers);
    } else {
      logEvent("error", "api.unexpected_error", { ...log, error: describeError(error) });
      response = errorResponse("internal_error");
    }
  }
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-trace-id", traceId);
  logEvent(response.status >= 500 ? "error" : "info", "api.request", {
    ...log,
    status: response.status,
    ms: Date.now() - started,
  });
  return response;
}

async function dispatch(
  request: Request,
  url: URL,
  env: Env,
  runtime: Runtime,
  log: LogFields,
  traceId: string,
): Promise<Response> {
  if (url.pathname === "/api/health") {
    log["route"] = url.pathname;
    if (request.method !== "GET") throw new ApiFailure("method_not_allowed", { allow: "GET" });
    return Response.json({ status: "ok", service: "worker" } satisfies WorkerHealth);
  }
  const match = matchRoute(routes, request.method, url.pathname);
  if (match.kind === "not_found") throw new ApiFailure("not_found");
  if (match.kind === "method_not_allowed") {
    throw new ApiFailure("method_not_allowed", { allow: match.allow.join(", ") });
  }
  log["route"] = `${match.route.method} ${match.route.path}`;

  const config = loadConfig(env);
  const identity = await verifyAccessToken(request, config.access);
  if (request.method !== "GET" && !config.appOrigins.has(request.headers.get("origin") ?? "")) {
    throw new ApiFailure("forbidden");
  }
  const deps = serviceDeps(env, runtime);
  const user = await resolveUser(deps, identity);
  log["userId"] = user.id;
  return match.route.handle({ request, url, deps, user, params: match.params, log, traceId });
}
