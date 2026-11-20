import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { getTestPlatformProxy } from "./platform-proxy.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import { accessAssertionHeader } from "@madori/contracts";
import { verifyAccessToken } from "../../src/api/access.ts";
import { authenticatedUser } from "../../src/owner.ts";
import type { OwnerId } from "../../src/owner.ts";
import { upsertAccessUser } from "../../src/storage/users.ts";
import { d1 } from "../../src/storage/d1.ts";
import type { D1, SqlPart } from "../../src/storage/d1.ts";
import { createOnceStatements, updateOnceStatements, runOnce } from "../../src/storage/requests.ts";
import type { OnceBatch, RequestKey } from "../../src/storage/requests.ts";

void test("once-only batches preserve their private protocol on real D1", async (t) => {
  const proxy = await getTestPlatformProxy<Pick<Env, "DB">>({
    configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
  });
  try {
    const raw = proxy.env.DB;
    const sql = await readFile(
      new URL("../../migrations/0001_users_projects_patterns.sql", import.meta.url),
      "utf8",
    );
    await raw.batch(
      sql
        .replace(/--[^\n]*/gu, "")
        .split(";")
        .filter((statement) => statement.trim())
        .map((statement) => raw.prepare(statement)),
    );
    const db = d1(raw);
    const now = "2026-11-15T00:00:00.000Z";
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwks = {
      keys: [{ ...(await exportJWK(publicKey)), kty: "RSA", kid: "once-test", alg: "RS256" }],
    };
    const source = JSON.stringify(jwks);
    async function owner(subject: string) {
      const issuer = "https://once.invalid";
      const token = await new SignJWT({ email: subject + "@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "once-test" })
        .setIssuer(issuer)
        .setAudience("once-test")
        .setSubject(subject)
        .setExpirationTime("5m")
        .sign(privateKey);
      const identity = await verifyAccessToken(
        new Request("https://app.test/api/me", { headers: { [accessAssertionHeader]: token } }),
        { issuer, audience: "once-test", keys: { kind: "local", jwks, source } },
      );
      return authenticatedUser(
        identity,
        await upsertAccessUser(db, { identity, newId: crypto.randomUUID(), now }),
      ).id;
    }
    const ownerA = await owner("a");
    const ownerB = await owner("b");
    const key = (ownerId: OwnerId = ownerA): RequestKey => ({
      ownerId,
      requestId: crypto.randomUUID(),
      operation: "project.create",
      fingerprint: "fixture",
    });
    const schema = z.object({ name: z.string() });
    function creation(request = key()) {
      const id = crypto.randomUUID();
      const statement = {
        sql: "INSERT INTO projects (id, owner_id, name, version, next_pattern_number, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)",
        bindings: [id, request.ownerId, "original", now, now],
      };
      const result = {
        sql: "SELECT json_object('name', name) FROM projects WHERE id = ?",
        bindings: [id],
      };
      const input = { statements: [statement], table: "projects", id, result } satisfies Parameters<
        typeof createOnceStatements
      >[2];
      return { request, statement, input, batch: createOnceStatements(request, now, input) };
    }
    const counts = async () =>
      Promise.all(
        ["projects", "patterns", "requests"].map((table) =>
          raw.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
        ),
      );
    const record = (request: RequestKey) =>
      raw
        .prepare("SELECT result FROM requests WHERE owner_id = ? AND request_id = ?")
        .bind(request.ownerId, request.requestId)
        .first("result");

    await t.test(
      "Object.assign between genuine batches preserves the original private payload and key",
      async () => {
        const original = creation();
        const other = creation(key(ownerB));
        assert.equal(Object.assign(original.batch, other.batch), original.batch);
        assert.deepEqual(await runOnce(db, schema, original.batch), {
          kind: "applied",
          result: { name: "original" },
        });
        assert.equal(await record(original.request), '{"name":"original"}');
        assert.equal(await record(other.request), null);
        assert.equal(
          await raw.prepare("SELECT id FROM projects WHERE id = ?").bind(other.input.id).first(),
          null,
        );
        assert.deepEqual(await runOnce(db, schema, original.batch), {
          kind: "replayed",
          result: { name: "original" },
        });
      },
    );

    await t.test(
      "byte-array getters are rejected before a conditional update can be built",
      async () => {
        const made = creation();
        await runOnce(db, schema, made.batch);
        const request = key();
        let reads = 0;
        const bytes = [0];
        Object.defineProperty(bytes, 0, { get: () => (++reads % 2 === 1 ? 1 : 2) });
        const before = await counts();
        assert.throws(
          () =>
            updateOnceStatements(request, now, {
              table: "projects",
              set: { sql: "name = ?, version = version + 1", bindings: ["renamed"] },
              where: {
                sql: "id = ? AND owner_id = ? AND version = 1 AND ? = X'01'",
                bindings: [made.input.id, ownerA, bytes],
              },
              result: { sql: "SELECT json_object('name', 'renamed')", bindings: [] },
            }),
          TypeError,
        );
        assert.equal(reads, 0);
        assert.deepEqual(await counts(), before);
        assert.equal(await record(request), null);
        assert.deepEqual(
          await raw
            .prepare("SELECT name, version FROM projects WHERE id = ?")
            .bind(made.input.id)
            .first(),
          { name: "original", version: 1 },
        );
      },
    );

    await t.test(
      "typed-array bindings are rejected before creation statements can be built",
      async () => {
        const made = creation();
        const bytes = new Uint8Array([1]);
        const before = await counts();
        assert.throws(
          () =>
            createOnceStatements(made.request, now, {
              ...made.input,
              statements: [
                {
                  sql: "INSERT INTO projects (id, owner_id, name, version, next_pattern_number, created_at, updated_at) SELECT ?, ?, 'original', 1, 1, ?, ? WHERE ? = X'01'",
                  bindings: [made.input.id, ownerA, now, now, bytes],
                },
              ],
            }),
          TypeError,
        );
        bytes[0] = 2;
        assert.deepEqual(await counts(), before);
        assert.equal(await record(made.request), null);
        assert.equal(
          await raw.prepare("SELECT id FROM projects WHERE id = ?").bind(made.input.id).first(),
          null,
        );
      },
    );

    await t.test(
      "string, number, boolean and null bindings remain usable for updates and replay",
      async () => {
        const made = creation();
        await runOnce(db, schema, made.batch);
        const request = key();
        const batch = updateOnceStatements(request, now, {
          table: "projects",
          set: { sql: "name = ?, version = version + ?", bindings: ["renamed", 1] },
          where: {
            sql: "id = ? AND owner_id = ? AND ? = 1 AND ? IS NULL",
            bindings: [made.input.id, ownerA, true, null],
          },
          result: { sql: "SELECT json_object('name', ?)", bindings: ["renamed"] },
        });
        assert.deepEqual(await runOnce(db, schema, batch), {
          kind: "applied",
          result: { name: "renamed" },
        });
        assert.deepEqual(
          await raw
            .prepare("SELECT name, version FROM projects WHERE id = ?")
            .bind(made.input.id)
            .first(),
          { name: "renamed", version: 2 },
        );
        assert.equal(await record(request), '{"name":"renamed"}');
        const after = await counts();
        assert.deepEqual(await runOnce(db, schema, batch), {
          kind: "replayed",
          result: { name: "renamed" },
        });
        assert.deepEqual(await counts(), after);
      },
    );

    await t.test(
      "caller array methods and species cannot change the captured writes",
      async (t) => {
        for (const mode of ["subclass", "own constructor"] as const) {
          for (const attack of ["replace", "append"] as const) {
            await t.test(mode + " " + attack, async () => {
              const made = creation();
              const foreign = creation(key(ownerB));
              await runOnce(db, schema, foreign.batch);
              const swapped: SqlPart = {
                sql: made.statement.sql,
                bindings: [made.input.id, ownerA, "swapped", now, now],
              };
              const foreignUpdate: SqlPart = {
                sql: "UPDATE projects SET name = 'injected' WHERE id = ? AND owner_id = ?",
                bindings: [foreign.input.id, ownerB],
              };
              let execution: "original" | "replace" | "append" = "original";
              class Shifting extends Array<SqlPart> {
                override map<U>(
                  callback: (value: SqlPart, index: number, array: SqlPart[]) => U,
                  thisArg?: unknown,
                ): U[] {
                  if (execution === "replace") return [callback(swapped, 0, this)];
                  const mapped = super.map(callback, thisArg);
                  if (execution === "append")
                    mapped.push(callback(foreignUpdate, this.length, this));
                  return mapped;
                }
              }
              const statements =
                mode === "subclass" ? new Shifting(made.statement) : [made.statement];
              if (mode === "own constructor") {
                Object.defineProperty(statements, "constructor", { value: Shifting });
              }
              const batch = createOnceStatements(made.request, now, { ...made.input, statements });
              execution = attack;
              const before = z.tuple([z.number(), z.number(), z.number()]).parse(await counts());
              const sent: string[] = [];
              const observed: D1 = {
                ...db,
                batch(statements) {
                  sent.push(...statements.map((statement) => statement.sql));
                  return db.batch(statements);
                },
              };
              assert.deepEqual(await runOnce(observed, schema, batch), {
                kind: "applied",
                result: { name: "original" },
              });
              assert.equal(sent.length, 2);
              assert.equal(sent[0], made.statement.sql);
              assert.match(sent[1] ?? "", /^INSERT INTO requests/u);
              assert.equal(await record(made.request), '{"name":"original"}');
              assert.equal(
                await raw
                  .prepare("SELECT name FROM projects WHERE id = ?")
                  .bind(made.input.id)
                  .first("name"),
                "original",
              );
              assert.equal(
                await raw
                  .prepare("SELECT name FROM projects WHERE id = ?")
                  .bind(foreign.input.id)
                  .first("name"),
                "original",
              );
              const after = [before[0] + 1, before[1], before[2] + 1];
              assert.deepEqual(await counts(), after);
              assert.deepEqual(await runOnce(observed, schema, batch), {
                kind: "replayed",
                result: { name: "original" },
              });
              assert.deepEqual(await counts(), after);
            });
          }
        }
      },
    );

    await t.test(
      "constructors and prototypes cannot replace the private reader or mint a batch",
      async () => {
        const real = creation();
        const other = creation();
        const before = await counts();
        const read = () => ({
          key: other.request,
          parts: {
            before: [other.statement],
            record: { sql: `SELECT '{"name":"forged"}' AS result`, bindings: [] },
            after: [],
          },
        });
        assert.throws(() => Object.assign(real.batch.constructor, { read }), TypeError);
        assert.throws(
          () => Object.defineProperty(real.batch.constructor, "read", { value: read }),
          TypeError,
        );
        assert.equal(Reflect.set(real.batch.constructor, "read", read), false);
        assert.equal(Object.isFrozen(Object.getPrototypeOf(real.batch)), true);
        for (const token of [undefined, Symbol("OnceBatch"), {}]) {
          assert.throws(() => {
            Reflect.construct(real.batch.constructor, [
              token,
              other.request,
              { before: [other.statement], record: { sql: "SELECT 1", bindings: [] }, after: [] },
            ]);
          }, TypeError);
        }
        assert.deepEqual(await counts(), before);
        assert.deepEqual(await runOnce(db, schema, real.batch), {
          kind: "applied",
          result: { name: "original" },
        });
        assert.equal(await record(other.request), null);
      },
    );

    await t.test(
      "each request and SQL getter is read once before building a creation or update",
      async () => {
        const made = creation();
        await runOnce(db, schema, made.batch);
        for (const operation of ["create", "update"] as const) {
          const savedKey = key();
          const reads = new Map<string, number>();
          function once<T>(name: string, value: T): T {
            const count = (reads.get(name) ?? 0) + 1;
            reads.set(name, count);
            assert.equal(count, 1, name + " must be read once");
            return value;
          }
          const request: RequestKey = {
            get ownerId() {
              return once("ownerId", savedKey.ownerId);
            },
            get requestId() {
              return once("requestId", savedKey.requestId);
            },
            get operation() {
              return once("operation", savedKey.operation);
            },
            get fingerprint() {
              return once("fingerprint", savedKey.fingerprint);
            },
          };
          function part(name: string, sql: string, bindings: unknown[]) {
            return {
              get sql() {
                return once(name + ".sql", sql);
              },
              get bindings() {
                return once(name + ".bindings", bindings);
              },
            };
          }
          let batch: OnceBatch;
          if (operation === "create") {
            const id = crypto.randomUUID();
            batch = createOnceStatements(request, now, {
              table: "projects",
              id,
              statements: [part("insert", made.statement.sql, [id, ownerA, "getter", now, now])],
              result: part(
                "result",
                "SELECT json_object('name', name) FROM projects WHERE id = ?",
                [id],
              ),
            });
          } else {
            batch = updateOnceStatements(request, now, {
              table: "projects",
              set: part("set", "name = ?, version = version + 1", ["getter"]),
              where: part("where", "id = ? AND owner_id = ? AND version = ?", [
                made.input.id,
                ownerA,
                1,
              ]),
              result: part("result", "SELECT json_object('name', ?)", ["getter"]),
            });
          }
          assert.deepEqual(await runOnce(db, schema, batch), {
            kind: "applied",
            result: { name: "getter" },
          });
          assert.equal(await record(savedKey), '{"name":"getter"}');
          assert.deepEqual(await runOnce(db, schema, batch), {
            kind: "replayed",
            result: { name: "getter" },
          });
          assert.equal(reads.size, operation === "create" ? 8 : 10);
        }
        assert.deepEqual(
          await raw
            .prepare("SELECT name, version FROM projects WHERE id = ?")
            .bind(made.input.id)
            .first(),
          { name: "getter", version: 2 },
        );
      },
    );

    await t.test("reflected access cannot mutate captured keys, statements or arrays", async () => {
      const made = creation();
      const updated = updateOnceStatements(key(), now, {
        table: "projects",
        set: { sql: "name = ?", bindings: ["updated"] },
        where: { sql: "id = ? AND owner_id = ?", bindings: [made.input.id, ownerA] },
        result: { sql: "SELECT json_object('name', 'updated')", bindings: [] },
      });
      for (const batch of [made.batch, updated]) {
        const reader: unknown = Reflect.get(batch.constructor, "read");
        assert(typeof reader === "function");
        const snapshot: unknown = Reflect.apply(reader, undefined, [batch]);
        assert(
          snapshot !== null &&
            typeof snapshot === "object" &&
            "key" in snapshot &&
            "parts" in snapshot,
        );
        const savedKey = snapshot.key;
        assert(savedKey !== null && typeof savedKey === "object");
        assert(Object.isFrozen(savedKey));
        assert.throws(() => Object.assign(savedKey, { requestId: "changed" }), TypeError);
        const parts = snapshot.parts;
        assert(
          parts !== null &&
            typeof parts === "object" &&
            "before" in parts &&
            "record" in parts &&
            "after" in parts,
        );
        assert(Object.isFrozen(parts));
        const before = parts.before;
        const after = parts.after;
        assert(Array.isArray(before) && Array.isArray(after));
        assert(Object.isFrozen(before));
        assert(Object.isFrozen(after));
        assert.throws(() => before.push({ sql: "DELETE FROM projects", bindings: [] }), TypeError);
        assert.throws(() => after.push({ sql: "DELETE FROM projects", bindings: [] }), TypeError);
        const beforeStatements: readonly unknown[] = before;
        const afterStatements: readonly unknown[] = after;
        const statements = [parts.record, ...beforeStatements, ...afterStatements];
        for (const statement of statements) {
          assert(statement !== null && typeof statement === "object" && "bindings" in statement);
          assert(Object.isFrozen(statement));
          const bindings = statement.bindings;
          assert(Array.isArray(bindings));
          assert(Object.isFrozen(bindings));
          assert.throws(() => Object.assign(statement, { sql: "DELETE FROM projects" }), TypeError);
          assert.throws(() => bindings.push("changed"), TypeError);
        }
      }
      assert.deepEqual(await runOnce(db, schema, made.batch), {
        kind: "applied",
        result: { name: "original" },
      });
      assert.deepEqual(await runOnce(db, schema, updated), {
        kind: "applied",
        result: { name: "updated" },
      });
    });

    await t.test(
      "forged batches reject before any D1 call and leave rows and records unchanged",
      async (t) => {
        const real = creation();
        let getCalls = 0;
        let sqlCalls = 0;
        const observed: D1 = {
          ...db,
          async batch(...args) {
            sqlCalls++;
            return db.batch(...args);
          },
          async first(...args) {
            sqlCalls++;
            return db.first(...args);
          },
          async all(...args) {
            sqlCalls++;
            return db.all(...args);
          },
        };
        const forged = {
          before: [real.statement],
          record: { sql: "SELECT 1", bindings: [] },
          after: [],
        };
        const prototype: unknown = Object.getPrototypeOf(real.batch);
        assert(prototype === null || typeof prototype === "object");
        const prototypeCopy: unknown = Object.create(prototype);
        const cases: [string, unknown][] = [
          [
            "proxy",
            new Proxy(real.batch, {
              get() {
                getCalls++;
                return forged;
              },
            }),
          ],
          ["cast old shape", forged],
          ["structured clone", structuredClone(real.batch)],
          ["spread", { ...real.batch }],
          ["prototype copy", prototypeCopy],
        ];
        for (const [name, batch] of cases) {
          await t.test(name, async () => {
            const before = await counts();
            await assert.rejects(runOnce(observed, schema, batch as OnceBatch), TypeError);
            assert.equal(sqlCalls, 0);
            assert.deepEqual(await counts(), before);
          });
        }
        assert.equal(getCalls, 0);
      },
    );

    await t.test(
      "a foreign owner's existing project or pattern cannot be creation evidence",
      async () => {
        const foreign = creation(key(ownerB));
        await runOnce(db, schema, foreign.batch);
        const patternId = crypto.randomUUID();
        await raw
          .prepare(
            "INSERT INTO patterns (id, project_id, owner_id, number, name, version, created_at, updated_at) VALUES (?, ?, ?, 1, 'foreign', 1, ?, ?)",
          )
          .bind(patternId, foreign.input.id, ownerB, now, now)
          .run();
        for (const [table, id] of [
          ["projects", foreign.input.id],
          ["patterns", patternId],
        ] as const) {
          const request = key();
          const batch = createOnceStatements(request, now, {
            statements: [],
            table,
            id,
            result: {
              sql: `SELECT json_object('name', name) FROM ${table} WHERE id = ?`,
              bindings: [id],
            },
          });
          const before = await counts();
          assert.deepEqual(await runOnce(db, schema, batch), { kind: "not_applied" });
          assert.equal(await record(request), null);
          assert.deepEqual(await counts(), before);
        }
      },
    );

    await t.test(
      "creation snapshots caller statements, bindings, result, descriptor and request key",
      async () => {
        const made = creation();
        const request = { ...made.request };
        const id = made.input.id;
        made.statement.sql = "DELETE FROM projects";
        made.statement.bindings.fill("changed");
        made.input.statements.splice(0);
        made.input.statements.push({ sql: "DELETE FROM projects", bindings: [] });
        made.input.result.sql = "SELECT json_object('name', 'wrong')";
        made.input.result.bindings[0] = "missing";
        made.input.id = "missing";
        Object.assign(made.request, key(ownerB));
        assert.deepEqual(await runOnce(db, schema, made.batch), {
          kind: "applied",
          result: { name: "original" },
        });
        assert.equal(await record(request), '{"name":"original"}');
        assert.equal(await record(made.request), null);
        assert.equal(
          await raw.prepare("SELECT name FROM projects WHERE id = ?").bind(id).first("name"),
          "original",
        );
        assert.deepEqual(await runOnce(db, schema, made.batch), {
          kind: "replayed",
          result: { name: "original" },
        });
      },
    );

    await t.test(
      "update bindings are iterated once, so the record and the update see the same rows",
      async () => {
        const target = creation();
        const decoy = creation();
        await runOnce(db, schema, target.batch);
        await runOnce(db, schema, decoy.batch);
        let iterations = 0;
        class Shifting extends Array<unknown> {
          override [Symbol.iterator]() {
            const values: unknown[] =
              ++iterations === 1 ? [target.input.id, ownerA] : [decoy.input.id, ownerA];
            return values.values();
          }
        }
        const request = key();
        request.operation = "project.rename";
        const batch = updateOnceStatements(request, now, {
          table: "projects",
          set: { sql: "name = ?, version = version + 1", bindings: ["renamed"] },
          where: {
            sql: "id = ? AND owner_id = ?",
            bindings: Shifting.from([target.input.id, ownerA]),
          },
          result: { sql: "SELECT json_object('name', ?)", bindings: ["renamed"] },
        });
        assert.deepEqual(await runOnce(db, schema, batch), {
          kind: "applied",
          result: { name: "renamed" },
        });
        const row = (id: string) =>
          raw.prepare("SELECT name, version FROM projects WHERE id = ?").bind(id).first();
        assert.deepEqual(await row(target.input.id), { name: "renamed", version: 2 });
        assert.deepEqual(await row(decoy.input.id), { name: "original", version: 1 });
      },
    );

    await t.test(
      "updates snapshot every SQL part and replay using the captured request key",
      async () => {
        const made = creation();
        await runOnce(db, schema, made.batch);
        const request = key();
        request.operation = "project.rename";
        const savedKey = { ...request };
        const input = {
          table: "projects",
          set: { sql: "name = ?, version = version + 1", bindings: ["renamed"] },
          where: {
            sql: "id = ? AND owner_id = ? AND version = ?",
            bindings: [made.input.id, ownerA, 1],
          },
          result: { sql: "SELECT json_object('name', ?)", bindings: ["renamed"] },
        } satisfies Parameters<typeof updateOnceStatements>[2];
        const batch = updateOnceStatements(request, now, input);
        for (const part of [input.set, input.where, input.result]) {
          part.sql = "invalid SQL";
          part.bindings.fill("wrong");
        }
        Object.assign(request, key(ownerB));
        assert.deepEqual(await runOnce(db, schema, batch), {
          kind: "applied",
          result: { name: "renamed" },
        });
        assert.equal(await record(savedKey), '{"name":"renamed"}');
        assert.deepEqual(
          await raw
            .prepare("SELECT name, version FROM projects WHERE id = ?")
            .bind(made.input.id)
            .first(),
          { name: "renamed", version: 2 },
        );
        assert.deepEqual(await runOnce(db, schema, batch), {
          kind: "replayed",
          result: { name: "renamed" },
        });
      },
    );
  } finally {
    await proxy.dispose();
  }
});
