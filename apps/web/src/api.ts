import { displayContentType } from "@madori/contracts";
import { apiErrorSchema } from "@madori/contracts";
import type { ApiErrorCode } from "@madori/contracts";
export class ApiError extends Error {
  readonly code: ApiErrorCode | "network" | "unexpected_response";
  readonly retryAfter: number | undefined;
  constructor(code: ApiErrorCode | "network" | "unexpected_response", retryAfter?: number) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
export async function fetchSampleDisplay(signal: AbortSignal): Promise<Uint8Array> {
  try {
    const response = await fetch("/api/sample/display", { signal });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const error = apiErrorSchema.safeParse(body);
      const hint = response.headers.get("retry-after");
      const seconds = hint !== null && /^\d+$/.test(hint) ? Number(hint) : undefined;
      throw new ApiError(error.success ? error.data.error : "unexpected_response", seconds);
    }
    // Wasm validates the bytes at the decoding boundary.
    if (response.headers.get("content-type") !== displayContentType)
      throw new ApiError("unexpected_response");
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) throw error;
    throw new ApiError("network");
  }
}
