// Exercises the remote key path that production uses (`/cdn-cgi/access/certs`), which the
// local Worker cannot reach: verifyAccessToken runs in Node against a local key endpoint.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { test } from "node:test";
import { accessAssertionHeader } from "@madori/contracts";
import { errors } from "jose";
import { verifyAccessToken } from "../src/api/access.ts";
import type { AccessConfig } from "../src/api/config.ts";
import type { VerifiedIdentity } from "../src/identity.ts";
import { ApiFailure } from "../src/api/http.ts";
import { createAccessKey, signAccessToken } from "../../../scripts/dev/local-access.ts";
import type { AccessKey } from "../../../scripts/dev/local-access.ts";

function identityFields({ issuer, subject, email }: VerifiedIdentity) {
  return { issuer, subject, email };
}

const user = { subject: "user-1", email: "user@example.com" };

/** Starts a key endpoint that answers every request with `status` and `body`. */
async function keyEndpoint(status: number, body: string) {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return {
    issuer: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function verify(issuer: string, key: AccessKey, signer: AccessKey = key) {
  const token = await signAccessToken(signer, user, { issuer, audience: key.audience });
  const request = new Request("https://app.test/api/me", {
    headers: { [accessAssertionHeader]: token },
  });
  return verifyAccessToken(request, {
    issuer,
    audience: key.audience,
    keys: { kind: "remote" },
  });
}

await test("Remote Access keys", async (t) => {
  const key = await createAccessKey("unused", "remote-test");
  const jwks = JSON.stringify({ keys: [key.publicJwk] });

  await t.test("a token signed by a published key is accepted", async () => {
    const endpoint = await keyEndpoint(200, jwks);
    t.after(endpoint.close);
    assert.deepEqual(identityFields(await verify(endpoint.issuer, key)), {
      issuer: endpoint.issuer,
      subject: user.subject,
      email: user.email,
    });
  });

  await t.test("a token signed by an unpublished key is unauthenticated (401)", async () => {
    const endpoint = await keyEndpoint(200, jwks);
    t.after(endpoint.close);
    const stranger = await createAccessKey("unused", "remote-test");
    await assert.rejects(
      verify(endpoint.issuer, key, stranger),
      (error) => error instanceof ApiFailure && error.code === "unauthenticated",
    );
  });

  for (const [label, status, body] of [
    ["the key endpoint is down", 503, "{}"],
    ["the key endpoint returns broken JSON", 200, "{"],
    ["the key endpoint returns no key set", 200, JSON.stringify({ keys: "none" })],
  ] as const) {
    await t.test(`${label}: a server fault, not a sign-out`, async () => {
      const endpoint = await keyEndpoint(status, body);
      t.after(endpoint.close);
      // A jose error that is not a token error: it propagates and becomes a 500.
      await assert.rejects(verify(endpoint.issuer, key), (error) => {
        assert.ok(!(error instanceof ApiFailure), `got ApiFailure ${String(error)}`);
        return error instanceof errors.JOSEError;
      });
    });
  }
});

/** Signs a token by hand, so tests can send headers that jose refuses to produce. */
async function signRaw(
  key: AccessKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown> = {},
) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid: key.privateJwk.kid, ...header })}.${encode({
    iss: key.issuer,
    aud: key.audience,
    sub: user.subject,
    email: user.email,
    iat: now,
    exp: now + 300,
    ...claims,
  })}`;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    key.privateJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, Buffer.from(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

await test("Token shape", async (t) => {
  const key = await createAccessKey("https://access.test.invalid", "shape-test");
  const access: AccessConfig = {
    issuer: key.issuer,
    audience: key.audience,
    keys: {
      kind: "local",
      jwks: { keys: [{ ...key.publicJwk, kty: "RSA" }] },
      source: "single",
    },
  };
  const verifyToken = (token: string) =>
    verifyAccessToken(
      new Request("https://app.test/api/me", { headers: { [accessAssertionHeader]: token } }),
      access,
    );

  await t.test("a correctly signed hand-made token is accepted", async () => {
    assert.equal((await verifyToken(await signRaw(key, {}))).subject, user.subject);
  });

  await t.test("a token without a key ID is unauthenticated when several keys match", async () => {
    const previous = await createAccessKey(key.issuer, key.audience);
    const rotating: AccessConfig = {
      ...access,
      keys: {
        kind: "local",
        source: "rotating",
        jwks: {
          keys: [
            { ...key.publicJwk, kty: "RSA" },
            { ...previous.publicJwk, kty: "RSA" },
          ],
        },
      },
    };
    const token = await signRaw(key, { kid: undefined });
    await assert.rejects(
      verifyAccessToken(
        new Request("https://app.test/api/me", { headers: { [accessAssertionHeader]: token } }),
        rotating,
      ),
      (error) => error instanceof ApiFailure && error.code === "unauthenticated",
    );
  });

  await t.test("an unrecognized critical header is unauthenticated, not a fault", async () => {
    await assert.rejects(
      verifyToken(await signRaw(key, { crit: ["x-unknown"], "x-unknown": 1 })),
      (error) => error instanceof ApiFailure && error.code === "unauthenticated",
    );
  });
});

await test("Verifier service tokens", async (t) => {
  const key = await createAccessKey("https://access.test.invalid", "verifier-test");
  const access: AccessConfig = {
    issuer: key.issuer,
    audience: key.audience,
    keys: {
      kind: "local",
      jwks: { keys: [{ ...key.publicJwk, kty: "RSA" }] },
      source: JSON.stringify(key.publicJwk),
    },
  };
  const clientId = "verifier-client.access";
  const serviceClaims = { sub: "", common_name: clientId, email: undefined };
  const verifyClaims = async (claims: Record<string, unknown>, config: AccessConfig = access) =>
    verifyAccessToken(
      new Request("https://app.test/api/me", {
        headers: { [accessAssertionHeader]: await signRaw(key, {}, claims) },
      }),
      config,
    );
  const enabled = { ...access, verifierClientId: clientId };

  await t.test("the configured service token maps to a fixed verifier identity", async () => {
    const identity = await verifyClaims(serviceClaims, enabled);
    assert.deepEqual(identityFields(identity), {
      issuer: key.issuer,
      subject: "staging:verifier",
      email: "verifier@staging.invalid",
    });
    const replacement = "replacement-client.access";
    assert.deepEqual(
      identityFields(
        await verifyClaims(
          { ...serviceClaims, common_name: replacement },
          { ...access, verifierClientId: replacement },
        ),
      ),
      identityFields(identity),
      "rotating the configured Client ID preserves the verifier identity",
    );
  });

  for (const [label, claims, config] of [
    ["an unconfigured service token", serviceClaims, access],
    ["a different Client ID", { ...serviceClaims, common_name: "other.access" }, enabled],
    [
      "a Client ID with different case",
      { ...serviceClaims, common_name: clientId.toUpperCase() },
      enabled,
    ],
    ["a nonempty subject", { ...serviceClaims, sub: user.subject }, enabled],
    [
      "a service token with user claims",
      { ...serviceClaims, sub: user.subject, email: user.email },
      enabled,
    ],
    ["no Client ID", { ...serviceClaims, common_name: undefined }, enabled],
    ["an empty Client ID", { ...serviceClaims, common_name: "" }, enabled],
  ] satisfies [string, Record<string, unknown>, AccessConfig][]) {
    await t.test(`${label} is forbidden (403)`, async () => {
      await assert.rejects(
        verifyClaims(claims, config),
        (error) => error instanceof ApiFailure && error.code === "forbidden",
      );
    });
  }

  for (const [label, claims] of [
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["wrong issuer", { iss: "https://other.invalid" }],
    ["wrong audience", { aud: "other-app" }],
    ["missing subject", { sub: undefined }],
    ["missing expiry", { exp: undefined }],
  ] satisfies [string, Record<string, unknown>][]) {
    await t.test(`${label} service tokens remain unauthenticated (401)`, async () => {
      await assert.rejects(
        verifyClaims({ ...serviceClaims, ...claims }, enabled),
        (error) => error instanceof ApiFailure && error.code === "unauthenticated",
      );
    });
  }

  await t.test("a configured verifier does not change invited users", async () => {
    assert.deepEqual(identityFields(await verifyClaims({}, enabled)), {
      issuer: key.issuer,
      subject: user.subject,
      email: user.email,
    });
  });
});
