import type { OwnerId } from "../owner.ts";
import type { RequestKey } from "../storage/requests.ts";

// Which fields identify a request is a decision of each service operation; storage only
// stores and compares the resulting key.

/** Hashes what a request asks for; the request ID itself is not part of the fingerprint. */
export async function requestKey(
  ownerId: OwnerId,
  requestId: string,
  operation: string,
  input: Record<string, string | number | undefined>,
): Promise<RequestKey> {
  const canonical = JSON.stringify(
    Object.keys(input)
      .sort()
      .map((name) => [name, input[name] ?? null]),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${operation}\n${canonical}`),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { ownerId, requestId, operation, fingerprint };
}
