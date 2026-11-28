import { aiVerifierSubject, freezeIdentity, verifierSubject } from "../identity.ts";
import { accessAssertionHeader } from "@madori/contracts";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
} from "jose";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { VerifiedIdentity } from "../services/identity.ts";
import type { AccessConfig } from "./config.ts";
import { ApiFailure } from "./http.ts";

// Access has already verified the address; checking its syntax again would only lock out
// valid addresses (e.g. internationalized domains) that a stricter pattern rejects.
const claimsSchema = z.union([
  z.object({
    sub: z.string().min(1),
    email: z.string().min(1),
    common_name: z.never().optional(),
  }),
  z.object({ sub: z.literal(""), common_name: z.string().min(1) }),
]);

/**
 * jose errors that mean the token itself is bad (401). Every other error, including a plain
 * `JOSEError` from an unreachable or malformed key endpoint, is a server fault (500), so an
 * Access outage is not reported to users as being signed out.
 */
const tokenErrors = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JWKSNoMatchingKey,
  // Several published keys match a token without a `kid`; Access always sets one.
  errors.JWKSMultipleMatchingKeys,
];

function isTokenError(error: unknown): boolean {
  return tokenErrors.some((type) => error instanceof type);
}

// A key set caches imported and fetched keys, so keep one per key source for the isolate's
// life. The cache key is a string, so it holds even if configuration objects are rebuilt.
const keySets = new Map<string, JWTVerifyGetKey>();

function keySet(access: AccessConfig): JWTVerifyGetKey {
  const source =
    access.keys.kind === "local" ? `local:${access.keys.source}` : `remote:${access.issuer}`;
  let keys = keySets.get(source);
  if (!keys) {
    keys =
      access.keys.kind === "local"
        ? createLocalJWKSet(access.keys.jwks)
        : createRemoteJWKSet(new URL("/cdn-cgi/access/certs", access.issuer));
    keySets.set(source, keys);
  }
  return keys;
}

/**
 * Verifies the Access JWT's signature, issuer, audience and expiry (plan 4.4) and returns the
 * caller's identity. Nothing the browser sends is trusted as the identity without this.
 */
export async function verifyAccessToken(
  request: Request,
  access: AccessConfig,
): Promise<VerifiedIdentity> {
  const token = request.headers.get(accessAssertionHeader);
  if (!token) throw new ApiFailure("unauthenticated");
  // Access never sets "crit". jose reports unknown critical headers with JOSENotSupported,
  // which it also uses for unusable keys, so such tokens are rejected here, unambiguously.
  // Decoding only parses the client's token, so any failure here is the token's fault.
  let critical: unknown;
  try {
    critical = decodeProtectedHeader(token).crit;
  } catch {
    throw new ApiFailure("unauthenticated");
  }
  if (critical !== undefined) throw new ApiFailure("unauthenticated");
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, keySet(access), {
      issuer: access.issuer,
      audience: access.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    }));
  } catch (error) {
    if (isTokenError(error)) throw new ApiFailure("unauthenticated");
    throw error;
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new ApiFailure("forbidden");
  if (claims.data.common_name !== undefined) {
    const isAiVerifier = claims.data.common_name === access.aiVerifierClientId;
    if (!isAiVerifier && claims.data.common_name !== access.verifierClientId)
      throw new ApiFailure("forbidden");
    return freezeIdentity({
      issuer: access.issuer,
      subject: isAiVerifier ? aiVerifierSubject : verifierSubject,
      email: isAiVerifier ? "ai-verifier@staging.invalid" : "verifier@staging.invalid",
    } as VerifiedIdentity);
  }
  return freezeIdentity({
    issuer: access.issuer,
    subject: claims.data.sub,
    email: claims.data.email,
  } as VerifiedIdentity);
}
