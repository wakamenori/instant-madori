import type { ApiError, ApiErrorCode } from "@madori/contracts";
import type { z } from "zod";

const statusByCode = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  not_selectable: 409,
  method_not_allowed: 405,
  invalid_request: 400,
  unsupported_media_type: 415,
  invalid_image: 422,
  attachment_unavailable: 422,
  image_dimensions_too_large: 422,
  payload_too_large: 413,
  version_conflict: 409,
  request_id_reused: 422,
  internal_error: 500,
} as const satisfies Record<ApiErrorCode, number>;

const defaultMaxJsonBodyBytes = 16 * 1024;

/** Request methods defined by RFC 9110 and RFC 5789. */
const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
] as const;
export type HttpMethod = (typeof httpMethods)[number];

export function parseHttpMethod(method: string): HttpMethod | undefined {
  return httpMethods.find((known) => known === method);
}

export type RoutePath =
  | "/api/assets"
  | "/api/assets/:assetId"
  | "/api/me"
  | "/api/jobs/:jobId/stop"
  | "/api/projects"
  | "/api/projects/:projectId"
  | "/api/projects/:projectId/patterns"
  | "/api/patterns/:patternId"
  | "/api/patterns/:patternId/messages"
  | "/api/patterns/:patternId/queue/resume"
  | "/api/patterns/:patternId/queue/cancel"
  | "/api/patterns/:patternId/state"
  | "/api/patterns/:patternId/revisions"
  | "/api/revisions/:revisionId/pick"
  | "/api/revisions/:revisionId/view"
  | "/api/revisions/:revisionId/floor-plan";

/** An expected failure that ends the request with an API error code. */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly headers: Record<string, string>;

  constructor(code: ApiErrorCode, headers: Record<string, string> = {}) {
    super(code);
    this.name = "ApiFailure";
    this.code = code;
    this.headers = headers;
  }
}

export function errorResponse(code: ApiErrorCode, headers: Record<string, string> = {}): Response {
  return Response.json({ error: code } satisfies ApiError, { status: statusByCode[code], headers });
}

export async function readBodyBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new ApiFailure("payload_too_large");
  }
  if (!request.body) return new Uint8Array();
  // The runtime types the body stream loosely; each chunk is checked to be bytes.
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new Error("Request body chunk is not bytes");
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiFailure("payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reads a JSON request body and validates it against the contract schema. */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  { maxBytes = defaultMaxJsonBodyBytes }: { maxBytes?: number } = {},
): Promise<T> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new ApiFailure("invalid_request");
  }
  const bytes = await readBodyBytes(request, maxBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ApiFailure("invalid_request");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ApiFailure("invalid_request");
  return parsed.data;
}

/** Validates the query string. Repeated parameters are rejected rather than guessed. */
export function readQuery<T>(url: URL, schema: z.ZodType<T>): T {
  const query = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (query.has(name)) throw new ApiFailure("invalid_request");
    query.set(name, value);
  }
  // fromEntries defines own properties, so names like `__proto__` reach the strict schema.
  const parsed = schema.safeParse(Object.fromEntries(query));
  if (!parsed.success) throw new ApiFailure("invalid_request");
  return parsed.data;
}
