import assert from "node:assert/strict";
import { test } from "node:test";
import { accessAssertionHeader, meResponseSchema } from "@madori/contracts";
import { importJWK, SignJWT } from "jose";
import { createAccessKey, signAccessToken } from "../../../scripts/dev/local-access.ts";
import {
  newUser,
  startLocalWorker,
  testAlternateOrigin,
  testAppOrigin,
} from "./support/local-worker.ts";
import type { LocalWorker } from "./support/local-worker.ts";

async function status(worker: LocalWorker, token: string) {
  const response = await worker.call("/api/me", {
    headers: { [accessAssertionHeader]: token },
  });
  return response.status;
}

await test("Access authentication", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());

  await t.test("requests without an Access token are rejected", async () => {
    assert.equal((await worker.call("/api/me")).status, 401);
  });

  await t.test("service tokens remain forbidden without verifier configuration", async () => {
    const token = await new SignJWT({ common_name: "verifier-client.access" })
      .setProtectedHeader({ alg: "RS256", kid: worker.key.privateJwk.kid ?? "" })
      .setIssuer(worker.key.issuer)
      .setAudience(worker.key.audience)
      .setSubject("")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await importJWK(worker.key.privateJwk, "RS256"));
    const response = await worker.call("/api/me", {
      headers: { [accessAssertionHeader]: token },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  });

  await t.test(
    "tokens are rejected unless signature, issuer, audience and expiry all match",
    async () => {
      const user = newUser("auth");
      const otherKey = await createAccessKey(worker.key.issuer, worker.key.audience);
      assert.equal(await status(worker, await signAccessToken(otherKey, user)), 401, "foreign key");
      assert.equal(
        await status(
          worker,
          await signAccessToken(worker.key, user, { issuer: "https://other.invalid" }),
        ),
        401,
        "issuer",
      );
      assert.equal(
        await status(worker, await signAccessToken(worker.key, user, { audience: "another-app" })),
        401,
        "audience",
      );
      const past = Math.floor(Date.now() / 1000) - 60;
      assert.equal(
        await status(worker, await signAccessToken(worker.key, user, { expiresAt: past })),
        401,
        "expired",
      );
      assert.equal(await status(worker, "not-a-jwt"), 401, "malformed");
      assert.equal(await status(worker, await signAccessToken(worker.key, user)), 200, "valid");
    },
  );

  await t.test(
    "an Access identity maps to one internal user that follows email changes",
    async () => {
      const user = newUser("me");
      const first = meResponseSchema.parse(
        await (await worker.call("/api/me", { as: user })).json(),
      );
      assert.equal(first.user.email, user.email);
      const again = meResponseSchema.parse(
        await (await worker.call("/api/me", { as: user })).json(),
      );
      assert.equal(again.user.id, first.user.id);
      const renamed = { ...user, email: `new-${user.email}` };
      const moved = meResponseSchema.parse(
        await (await worker.call("/api/me", { as: renamed })).json(),
      );
      assert.deepEqual(moved.user, { id: first.user.id, email: renamed.email });
      const other = meResponseSchema.parse(
        await (await worker.call("/api/me", { as: newUser("other") })).json(),
      );
      assert.notEqual(other.user.id, first.user.id);
    },
  );

  await t.test("any address Access vouches for is accepted, including IDN domains", async () => {
    for (const email of ["sato@例え.jp", "admin@localhost"]) {
      const user = { subject: `test:${crypto.randomUUID()}`, email };
      const response = await worker.call("/api/me", { as: user });
      assert.equal(response.status, 200, email);
      assert.equal(meResponseSchema.parse(await response.json()).user.email, email);
    }
  });

  await t.test(
    "concurrent first requests of a new user create a single internal user",
    async () => {
      const user = newUser("race");
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => worker.call("/api/me", { as: user })),
      );
      const ids = new Set<string>();
      for (const response of responses) {
        assert.equal(response.status, 200);
        ids.add(meResponseSchema.parse(await response.json()).user.id);
      }
      assert.equal(ids.size, 1);
    },
  );

  await t.test("mutations must come from the app origin", async () => {
    const user = newUser("csrf");
    const body = { requestId: crypto.randomUUID() };
    for (const origin of [null, "https://evil.example", "null", `${testAppOrigin}.evil`]) {
      const response = await worker.call("/api/projects", {
        method: "POST",
        as: user,
        body,
        origin,
      });
      assert.equal(response.status, 403, String(origin));
    }
    const allowed = await worker.call("/api/projects", { method: "POST", as: user, body });
    assert.equal(allowed.status, 201);
    const alternate = await worker.call("/api/projects", {
      method: "POST",
      as: user,
      body: { requestId: crypto.randomUUID() },
      origin: testAlternateOrigin,
    });
    assert.equal(alternate.status, 201, "every configured origin is allowed");
  });
});
