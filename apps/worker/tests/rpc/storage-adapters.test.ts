import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { getTestPlatformProxy } from "./platform-proxy.ts";
import { z } from "zod";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessAssertionHeader } from "@madori/contracts";
import { verifyAccessToken } from "../../src/api/access.ts";
import { authenticatedUser } from "../../src/owner.ts";
import { accessUserFor, upsertAccessUser } from "../../src/storage/users.ts";
import { d1, jsonRows, rows, write } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";
import { StorageCorruption } from "../../src/storage/rows.ts";

void test("storage adapters validate real D1 results and reject R2 overwrites", async () => {
  const proxy = await getTestPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
    configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
  });
  try {
    const database = d1(proxy.env.DB);
    const item = z.object({ name: z.string() });
    const result = await database.batch([
      write({ sql: "CREATE TABLE adapter_test (value TEXT NOT NULL)", bindings: [] }),
      rows(
        {
          sql: "INSERT INTO adapter_test VALUES (?) RETURNING value AS result",
          bindings: ['{"name":"saved"}'],
        },
        z.object({ result: z.string() }),
        "record",
      ),
      jsonRows({ sql: "SELECT value AS json FROM adapter_test", bindings: [] }, item, "item"),
    ]);
    assert.deepEqual(result, [undefined, [{ result: '{"name":"saved"}' }], [{ name: "saved" }]]);
    assert.deepEqual(
      await database.first(
        jsonRows({ sql: "SELECT value AS json FROM adapter_test", bindings: [] }, item, "item"),
      ),
      { name: "saved" },
    );
    assert.equal(
      await database.first(
        jsonRows(
          { sql: "SELECT value AS json FROM adapter_test WHERE 0", bindings: [] },
          item,
          "item",
        ),
      ),
      null,
    );
    for (const json of ['{"name":1}', "{invalid", 42]) {
      await assert.rejects(
        database.all(jsonRows({ sql: "SELECT ? AS json", bindings: [json] }, item, "item")),
        StorageCorruption,
      );
    }
    await assert.rejects(
      database.batch([
        rows(
          { sql: "SELECT 'bad' AS found", bindings: [] },
          z.object({ found: z.literal(1) }),
          "existence",
        ),
      ]),
      StorageCorruption,
    );
    await assert.rejects(
      database.batch([
        write({ sql: "INSERT INTO adapter_test VALUES ('rolled back')", bindings: [] }),
        write({ sql: "INSERT INTO adapter_test VALUES (NULL)", bindings: [] }),
      ]),
      /NOT NULL constraint failed/,
    );
    assert.deepEqual(
      await database.all(
        jsonRows({ sql: "SELECT value AS json FROM adapter_test", bindings: [] }, item, "item"),
      ),
      [{ name: "saved" }],
    );

    const bucket = r2(proxy.env.BLOBS);
    const key = "adapter-test";
    assert.equal(await bucket.read(key), null);
    await bucket.putNew(key, new Uint8Array([1, 2]), "application/octet-stream");
    await assert.rejects(
      bucket.putNew(key, new Uint8Array([3, 4]), "application/octet-stream"),
      /already exists/,
    );
    assert.deepEqual(await bucket.read(key), { bytes: new Uint8Array([1, 2]) });
  } finally {
    await proxy.dispose();
  }
});

void test("owners require frozen verified identities and matching untampered D1 results", async () => {
  const proxy = await getTestPlatformProxy<Pick<Env, "DB">>({
    configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
  });
  try {
    const sql = await readFile(
      new URL("../../migrations/0001_users_projects_patterns.sql", import.meta.url),
      "utf8",
    );
    await proxy.env.DB.batch(
      sql
        .replace(/--[^\n]*/gu, "")
        .split(";")
        .filter((statement) => statement.trim())
        .map((statement) => proxy.env.DB.prepare(statement)),
    );
    const database = d1(proxy.env.DB);
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwks = {
      keys: [{ ...(await exportJWK(publicKey)), kty: "RSA", kid: "owner-test", alg: "RS256" }],
    };
    const source = JSON.stringify(jwks);
    const verify = async (
      subject: string,
      email = "owner@example.test",
      issuer = "https://owner.invalid",
    ) => {
      const token = await new SignJWT({ email })
        .setProtectedHeader({ alg: "RS256", kid: "owner-test" })
        .setIssuer(issuer)
        .setAudience("owner-test")
        .setSubject(subject)
        .setExpirationTime("5m")
        .sign(privateKey);
      return verifyAccessToken(
        new Request("https://app.test/api/me", {
          headers: { [accessAssertionHeader]: token },
        }),
        { issuer, audience: "owner-test", keys: { kind: "local", jwks, source } },
      );
    };
    const identity = await verify("owner");
    const now = "2026-11-15T00:00:00.000Z";
    const id = crypto.randomUUID();
    const resolved = await upsertAccessUser(database, { identity, newId: id, now });
    const user = authenticatedUser(identity, resolved);
    assert.deepEqual(user, { id, email: identity.email });
    assert.deepEqual(
      authenticatedUser(
        identity,
        await upsertAccessUser(database, {
          identity,
          newId: crypto.randomUUID(),
          now,
        }),
      ),
      user,
    );
    const changedEmail = await verify("owner", "changed@example.test");
    assert.deepEqual(
      authenticatedUser(
        changedEmail,
        await upsertAccessUser(database, {
          identity: changedEmail,
          newId: crypto.randomUUID(),
          now,
        }),
      ),
      { id, email: changedEmail.email },
    );
    for (const other of [
      await verify("other"),
      await verify("owner", identity.email, "https://other.invalid"),
    ]) {
      const foreign = await upsertAccessUser(database, {
        identity: other,
        newId: crypto.randomUUID(),
        now,
      });
      assert.notEqual(authenticatedUser(other, foreign).id, user.id);
      assert.throws(() => authenticatedUser(identity, foreign), /identity does not match/u);
      assert.throws(() => authenticatedUser(other, resolved), /identity does not match/u);
    }
    const victimId = crypto.randomUUID();
    const injected = Object.assign(resolved, {
      userFor: () => ({ id: victimId, email: "victim@example.test" }),
      id: victimId,
      user: { id: victimId, email: "victim@example.test" },
      issuer: "https://other.invalid",
      subject: "other",
      identity: await verify("other"),
      constructor: () => ({ id: victimId }),
    });
    injected.userFor = () => ({ id: victimId, email: "victim@example.test" });
    Object.setPrototypeOf(resolved, { userFor: injected.userFor });
    const exposed = accessUserFor(identity, resolved);
    exposed.id = victimId;
    assert.deepEqual(authenticatedUser(identity, resolved), user);
    const verifierToken = await new SignJWT({ common_name: "owner-verifier" })
      .setProtectedHeader({ alg: "RS256", kid: "owner-test" })
      .setIssuer(identity.issuer)
      .setAudience("owner-test")
      .setSubject("")
      .setExpirationTime("5m")
      .sign(privateKey);
    const verifier = await verifyAccessToken(
      new Request("https://app.test/api/me", {
        headers: { [accessAssertionHeader]: verifierToken },
      }),
      {
        issuer: identity.issuer,
        audience: "owner-test",
        keys: { kind: "local", jwks, source },
        verifierClientId: "owner-verifier",
      },
    );
    const { issuer, subject, email } = verifier;
    assert.deepEqual(
      { issuer, subject, email },
      {
        issuer: identity.issuer,
        subject: "staging:verifier",
        email: "verifier@staging.invalid",
      },
    );
    for (const verified of [identity, verifier]) {
      const mutable: { issuer: string; subject: string; email: string } = verified;
      for (const field of ["issuer", "subject", "email"] as const) {
        assert.throws(() => {
          mutable[field] = "victim";
        }, TypeError);
        assert.throws(() => Object.assign(verified, { [field]: "victim" }), TypeError);
        assert.throws(() => Object.defineProperty(verified, field, { value: "victim" }), TypeError);
        assert.throws(
          () =>
            Object.defineProperty(Object.getPrototypeOf(verified), field, { get: () => "victim" }),
          TypeError,
        );
      }
      assert.equal(Object.isFrozen(verified), true);
    }
    assert.deepEqual(authenticatedUser(identity, resolved), user);
  } finally {
    await proxy.dispose();
  }
});
