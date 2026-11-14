import { z } from "zod";

import {
  geometryInternal,
  healthSchema,
  geometryBodySchemas,
} from "@madori/contracts/geometry-internal";
import type { GeometryErrorCode } from "@madori/contracts/geometry-internal";
import type { GatewayRequest, GatewayResult, UnavailableReason } from "./container-gateway.ts";
export interface GeometryCall {
  traceId: string;
}
export interface BinaryBody {
  bytes: ArrayBuffer;
  contentType: string;
}
export type DisplayArtifact = BinaryBody;
type Violation =
  "content_type" | "too_large" | "invalid_json" | "schema" | "status" | "stream_chunk";
export type GeometryResult<T> =
  | { kind: "ok"; value: T; start: "cold" | "warm"; ms: number }
  | { kind: "unavailable"; reason: UnavailableReason }
  | { kind: "failed"; reason: GeometryErrorCode; status: number }
  | { kind: "failed"; reason: "protocol_violation"; status: number; violation: Violation };
export type Send = (request: GatewayRequest) => Promise<GatewayResult>;
export function acceptGeometryHealth(body: unknown): boolean {
  const parsed = healthSchema.safeParse(body);
  return parsed.success && parsed.data.protocol === geometryInternal.protocolVersion;
}

class BodyUnavailable extends Error {}
class ProtocolViolation extends Error {
  readonly violation: Violation;
  constructor(violation: Violation) {
    super(violation);
    this.violation = violation;
  }
}

async function readLimited(response: Response, limit: number): Promise<ArrayBuffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProtocolViolation("too_large");
  }
  const reader: ReadableStreamDefaultReader<unknown> | undefined = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw new BodyUnavailable();
      });
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ProtocolViolation("stream_chunk");
      length += value.byteLength;
      if (length > limit) throw new ProtocolViolation("too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
export interface GeometryAccept<T> {
  contentType: string;
  maxBytes: number;
  decode(bytes: ArrayBuffer): T;
}
export function acceptBytes(options: {
  contentType: string;
  maxBytes: number;
}): GeometryAccept<BinaryBody> {
  return { ...options, decode: (body) => ({ bytes: body, contentType: options.contentType }) };
}
export function acceptJson<T>(options: {
  schema: z.ZodType<T>;
  maxBytes: number;
}): GeometryAccept<T> {
  return {
    contentType: "application/json",
    maxBytes: options.maxBytes,
    decode: (body) => {
      const parsed = options.schema.safeParse(parseJson(body));
      if (!parsed.success) throw new ProtocolViolation("schema");
      return parsed.data;
    },
  };
}
function parseJson(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ProtocolViolation("invalid_json");
  }
}
type BodyDescriptor<K extends string = string> =
  | { kind: "none" }
  | { kind: "json"; schema: K; max_bytes: number }
  | { kind: "binary"; content_type: string; max_bytes: number };
type SchemaRegistry = Record<string, z.ZodType>;
type ResponseValue<R, S extends SchemaRegistry> = R extends {
  kind: "json";
  schema: infer K extends keyof S;
}
  ? z.output<S[K]>
  : R extends { kind: "binary" }
    ? BinaryBody
    : void;
type RequestOptions<R, S extends SchemaRegistry> = GeometryCall &
  (R extends {
    kind: "json";
    schema: infer K extends keyof S;
  }
    ? { body: z.input<S[K]>; contentType?: never }
    : R extends { kind: "binary" }
      ? { body: ArrayBuffer | Uint8Array<ArrayBuffer>; contentType?: never }
      : { body?: never; contentType?: never });
type RouteDescriptor<K extends string = string> = {
  path: string;
  method: GatewayRequest["method"];
  request: BodyDescriptor<K>;
  response: BodyDescriptor<K>;
};
function responsePolicy(body: BodyDescriptor, schemas: SchemaRegistry): GeometryAccept<unknown> {
  switch (body.kind) {
    case "json": {
      const schema = schemas[body.schema];
      if (!schema) throw new Error(`Unknown geometry schema: ${body.schema}`);
      return acceptJson({ schema, maxBytes: body.max_bytes });
    }
    case "binary":
      return acceptBytes({ contentType: body.content_type, maxBytes: body.max_bytes });
    case "none":
      return { contentType: "", maxBytes: 0, decode: () => undefined };
  }
}
async function decodeResponse<T>(response: Response, policy: GeometryAccept<T>): Promise<T> {
  if ((response.headers.get("content-type") ?? "") !== policy.contentType) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProtocolViolation("content_type");
  }
  return policy.decode(await readLimited(response, policy.maxBytes));
}
const errorPolicy = {
  ...acceptJson({
    schema: geometryBodySchemas[geometryInternal.error.schema],
    maxBytes: geometryInternal.error.max_bytes,
  }),
  contentType: geometryInternal.error.content_type,
};
export function createGeometryCaller<
  const R extends Record<string, RouteDescriptor<keyof S & string>>,
  S extends SchemaRegistry,
>(routes: R, schemas: S, timeouts: { [N in keyof R]: number }) {
  function call<N extends keyof R>(
    send: Send,
    name: N,
    options: RequestOptions<R[N]["request"], S>,
  ): Promise<GeometryResult<ResponseValue<R[N]["response"], S>>>;
  async function call(
    send: Send,
    name: keyof R,
    options: GeometryCall & { body?: unknown },
  ): Promise<GeometryResult<unknown>> {
    const route = routes[name];
    if (!route) throw new Error(`Unknown geometry route: ${String(name)}`);
    const accept = responsePolicy(route.response, schemas);
    let payload: Pick<GatewayRequest, "body" | "contentType"> = {};
    switch (route.request.kind) {
      case "none":
        break;
      case "json": {
        const schema = schemas[route.request.schema];
        if (!schema) throw new Error(`Unknown geometry schema: ${route.request.schema}`);
        payload = {
          body: JSON.stringify(schema.parse(options.body)),
          contentType: "application/json",
        };
        break;
      }
      case "binary":
        payload = {
          body: z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]).parse(options.body),
          contentType: route.request.content_type,
        };
        break;
    }
    const result = await send({
      traceId: options.traceId,
      ...payload,
      path: route.path,
      method: route.method,
      timeoutMs: timeouts[name],
    });
    if (result.kind === "unavailable") return result;
    const { response } = result;
    try {
      if (response.ok) {
        const value = await decodeResponse(response, accept);
        return { kind: "ok", value, start: result.start, ms: result.ms };
      }
      if (response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProtocolViolation("status");
      }
      const body = await decodeResponse(response, errorPolicy);
      return { kind: "failed", reason: body.error, status: response.status };
    } catch (error) {
      if (error instanceof BodyUnavailable) return { kind: "unavailable", reason: "unreachable" };
      if (!(error instanceof ProtocolViolation)) throw error;
      return {
        kind: "failed",
        reason: "protocol_violation",
        status: response.status,
        violation: error.violation,
      };
    }
  }
  return call;
}
export const routeTimeouts = { health: 2_000, sampleDisplay: 30_000 } satisfies Record<
  keyof typeof geometryInternal.routes,
  number
>;
export const callGeometry = createGeometryCaller(
  geometryInternal.routes,
  geometryBodySchemas,
  routeTimeouts,
);
export async function acceptReadinessResponse(response: Response): Promise<boolean> {
  const policy = responsePolicy(geometryInternal.routes.health.response, geometryBodySchemas);
  try {
    return acceptGeometryHealth(await decodeResponse(response, policy));
  } catch (error) {
    if (error instanceof ProtocolViolation) return false;
    throw error;
  }
}
export function readSampleDisplay(
  send: Send,
  call: GeometryCall,
): Promise<GeometryResult<DisplayArtifact>> {
  return callGeometry(send, "sampleDisplay", call);
}
