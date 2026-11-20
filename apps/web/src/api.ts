import {
  acceptInstructionResponseSchema,
  apiErrorSchema,
  createProjectResponseSchema,
  displayContentType,
  patternStateResponseSchema,
} from "@madori/contracts";
import type {
  AcceptInstructionRequest,
  ApiErrorCode,
  CreateProjectRequest,
} from "@madori/contracts";

export class ApiError extends Error {
  readonly code: ApiErrorCode | "network" | "unexpected_response";
  readonly retryAfter: number | undefined;
  constructor(code: ApiErrorCode | "network" | "unexpected_response", retryAfter?: number) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function request<T>(
  path: string,
  signal: AbortSignal,
  decode: (response: Response) => Promise<T>,
  body?: CreateProjectRequest | AcceptInstructionRequest,
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
      const hint = response.headers.get("retry-after");
      const seconds = hint !== null && /^\d+$/.test(hint) ? Number(hint) : undefined;
      throw new ApiError(error.success ? error.data.error : "unexpected_response", seconds);
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
      return result.data.pattern;
    },
    body,
  );
}

export function sendInstruction(
  patternId: string,
  body: AcceptInstructionRequest,
  signal: AbortSignal,
) {
  return request(
    `/api/patterns/${patternId}/messages`,
    signal,
    async (response) => {
      const result = acceptInstructionResponseSchema.safeParse(await jsonBody(response));
      if (!result.success) throw new ApiError("unexpected_response");
      return result.data.job;
    },
    body,
  );
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
    return new Uint8Array(await response.arrayBuffer());
  });
}
