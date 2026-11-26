import {
  projectListResponseSchema,
  patternListResponseSchema,
  apiErrorSchema,
  createProjectResponseSchema,
  displayContentType,
  floorPlanContentType,
  floorPlanStoreysHeader,
  parseFloorPlanStoreys,
  patternStateResponseSchema,
} from "@madori/contracts";
import type { ApiErrorCode, CreateProjectRequest } from "@madori/contracts";

export class ApiError extends Error {
  readonly code: ApiErrorCode | "network" | "unexpected_response";
  constructor(code: ApiErrorCode | "network" | "unexpected_response") {
    super(code);
    this.code = code;
  }
}

async function request<T>(
  path: string,
  signal: AbortSignal,
  decode: (response: Response) => Promise<T>,
  body?: CreateProjectRequest,
): Promise<T> {
  signal.throwIfAborted();
  try {
    const init: RequestInit =
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    const response = await fetch(path, { ...init, signal });
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(await response.json().catch(() => undefined));
      throw new ApiError(error.success ? error.data.error : "unexpected_response");
    }
    return await decode(response);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError("network");
  }
}

async function jsonBody(response: Response): Promise<unknown> {
  return response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) throw new ApiError("unexpected_response");
    throw error;
  });
}

export function createProject(body: CreateProjectRequest, signal: AbortSignal) {
  return request(
    "/api/projects",
    signal,
    async (response) => {
      const result = createProjectResponseSchema.safeParse(await jsonBody(response));
      if (!result.success) throw new ApiError("unexpected_response");
      return result.data;
    },
    body,
  );
}

export function listProjects(cursor: string | null, signal: AbortSignal) {
  const path =
    cursor === null ? "/api/projects" : `/api/projects?cursor=${encodeURIComponent(cursor)}`;
  return request(path, signal, async (response) => {
    const result = projectListResponseSchema.safeParse(await jsonBody(response));
    if (!result.success) throw new ApiError("unexpected_response");
    return result.data;
  });
}

export function listPatterns(projectId: string, signal: AbortSignal) {
  return request(`/api/projects/${projectId}/patterns`, signal, async (response) => {
    const result = patternListResponseSchema.safeParse(await jsonBody(response));
    if (!result.success) throw new ApiError("unexpected_response");
    return result.data.patterns;
  });
}

export function readPatternState(patternId: string, signal: AbortSignal) {
  return request(`/api/patterns/${patternId}/state`, signal, async (response) => {
    const result = patternStateResponseSchema.safeParse(await jsonBody(response));
    if (!result.success) throw new ApiError("unexpected_response");
    return result.data;
  });
}

export function fetchRevisionView(revisionId: string, signal: AbortSignal) {
  return request(`/api/revisions/${revisionId}/view`, signal, async (response) => {
    if (
      response.headers.get("content-type") !== displayContentType ||
      response.headers.get("x-revision-id") !== revisionId
    )
      throw new ApiError("unexpected_response");
    const storeys = parseFloorPlanStoreys(response.headers.get(floorPlanStoreysHeader));
    if (storeys === null) throw new ApiError("unexpected_response");
    return { display: new Uint8Array(await response.arrayBuffer()), storeys };
  });
}

export function fetchFloorPlan(
  revisionId: string,
  storey: string,
  signal: AbortSignal,
): Promise<string> {
  return request(
    `/api/revisions/${revisionId}/floor-plan?${new URLSearchParams({ storey })}`,
    signal,
    async (response) => {
      if (
        response.headers.get("content-type") !== floorPlanContentType ||
        response.headers.get("x-revision-id") !== revisionId
      )
        throw new ApiError("unexpected_response");
      return response.text();
    },
  );
}
