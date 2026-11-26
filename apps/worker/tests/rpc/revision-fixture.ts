import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { getTestPlatformProxy } from "./platform-proxy.ts";
import { z } from "zod";
import { requestKey } from "../../src/services/requests.ts";
import {
  acceptInstruction,
  claimNextJob,
  saveJobSnapshot,
  completeJob,
} from "../../src/services/jobs.ts";
import type { Runtime } from "../../src/services/deps.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";
import { accessAssertionHeader } from "@madori/contracts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyAccessToken } from "../../src/api/access.ts";
import { resolveUser } from "../../src/services/users.ts";
import { StorageCorruption } from "../../src/storage/rows.ts";

const state = z.string().min(1).parse(process.argv[2]);
// getMiniflarePersistRoot takes a literal path; dev appends v3 to --persist-to.
// The HTTP harness has stopped its Worker before launching this process.
const proxy = await getTestPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
  configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
  persist: { path: join(state, "v3") },
  remoteBindings: false,
});
try {
  const { DB: db, BLOBS: bucket } = proxy.env;
  const store = createStore(d1(db), r2(bucket));
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwks = {
    keys: [{ ...(await exportJWK(publicKey)), kty: "RSA", kid: "revision-fixture", alg: "RS256" }],
  };
  const source = JSON.stringify(jwks);
  const signedInOwner = z.uuid().transform(async (id) => {
    const user = z
      .object({ issuer: z.string(), subject: z.string(), email: z.string() })
      .parse(
        await db
          .prepare(
            "SELECT access_issuer AS issuer, access_subject AS subject, email FROM users WHERE id = ?",
          )
          .bind(id)
          .first(),
      );
    const token = await new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: "RS256", kid: "revision-fixture" })
      .setIssuer(user.issuer)
      .setSubject(user.subject)
      .setAudience("revision-fixture")
      .setExpirationTime("5m")
      .sign(privateKey);
    const identity = await verifyAccessToken(
      new Request("https://app.test/api/me", {
        headers: { [accessAssertionHeader]: token },
      }),
      { issuer: user.issuer, audience: "revision-fixture", keys: { kind: "local", jwks, source } },
    );
    const authenticated = await resolveUser(
      {
        store,
        runtime: {
          now: () => new Date().toISOString(),
          newId: () => crypto.randomUUID(),
          newTraceId: () => crypto.randomUUID(),
        },
      },
      identity,
    );
    assert.equal(authenticated.id, id);
    return authenticated.id;
  });
  const input = await z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal(["commit", "pick"]),
        ownerId: signedInOwner,
        patternId: z.uuid(),
      }),
      z.object({
        kind: z.literal("damage"),
        ownerId: signedInOwner,
        revisionId: z.uuid(),
        target: z.enum(["display", "manifest"]),
        missing: z.boolean(),
      }),
      z.object({ kind: z.literal("once"), ownerId: signedInOwner }),
    ])
    .parseAsync(JSON.parse(process.argv[3] ?? ""));
  if (input.kind === "damage") {
    const snapshot = await store.revisions.snapshot(input);
    assert(snapshot);
    const key =
      input.target === "manifest"
        ? snapshot.manifestKey
        : snapshot.manifestKey.replace(/manifest\.json$/, "display.mdsp");
    if (input.missing) await bucket.delete(key);
    else {
      const object = await bucket.get(key);
      assert(object);
      // Same length and still valid, but different bytes: only the hash comparison can catch it.
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (input.target === "manifest") {
        const { formatVersion, display } = z
          .object({ formatVersion: z.unknown(), display: z.unknown() })
          .parse(JSON.parse(new TextDecoder().decode(bytes)));
        const reordered = new TextEncoder().encode(JSON.stringify({ display, formatVersion }));
        assert.equal(reordered.byteLength, bytes.byteLength);
        assert.notDeepEqual(reordered, bytes);
        await bucket.put(key, reordered);
      } else {
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        await bucket.put(key, bytes);
      }
    }
    if (input.target === "manifest")
      await assert.rejects(store.snapshots.open(snapshot), StorageCorruption);
    else
      await assert.rejects(
        (await store.snapshots.open(snapshot)).display.read(),
        StorageCorruption,
      );
    console.log(JSON.stringify({ ok: true }));
  } else if (input.kind === "once") {
    const now = "2026-11-14T00:00:00.000Z";
    const key = (operation: string) =>
      requestKey(input.ownerId, crypto.randomUUID(), operation, {});
    const twice = async (run: () => Promise<{ kind: string }>) => [
      (await run()).kind,
      (await run()).kind,
    ];
    const projectId = crypto.randomUUID();
    const createProject = await key("project.create");
    assert.deepEqual(
      await twice(() =>
        store.projects.createOnce(createProject, {
          id: projectId,
          name: "once",
          now,
          firstPattern: { id: crypto.randomUUID(), name: null, defaultNamePrefix: "パターン" },
        }),
      ),
      ["applied", "replayed"],
    );
    const createPattern = await key("pattern.create");
    const pattern = {
      id: crypto.randomUUID(),
      projectId,
      name: null,
      defaultNamePrefix: "パターン",
      now,
    };
    assert.deepEqual(await twice(() => store.patterns.createOnce(createPattern, pattern)), [
      "applied",
      "replayed",
    ]);
    const renameProject = await key("project.rename");
    assert.deepEqual(
      await twice(() =>
        store.projects.renameOnce(renameProject, {
          projectId,
          expectedVersion: 1,
          name: "renamed",
          now,
        }),
      ),
      ["applied", "replayed"],
    );
    console.log(JSON.stringify({ ok: true }));
  } else {
    const firstDisplay = new Uint8Array(
      await readFile(
        new URL("../../../../crates/display/tests/fixtures/v1-two-bodies.mdsp", import.meta.url),
      ),
    );
    const display = new Uint8Array(
      await readFile(new URL("../../../../crates/display/tests/two-bodies.mdsp", import.meta.url)),
    );
    assert.notDeepEqual(display, firstDisplay);
    // The clock runs backwards, so ordering by created_at instead of number would show.
    let clock = Date.parse("2026-11-14T00:00:00.000Z");
    const runtime: Runtime = {
      now: () => new Date((clock -= 1000)).toISOString(),
      newId: () => crypto.randomUUID(),
      newTraceId: () => crypto.randomUUID(),
    };
    const deps = { store, runtime, wakePattern: async () => {} };
    const commit = async (bytes = display, name = "案", withHouse = false) => {
      const accepted = await acceptInstruction(deps, {
        ownerId: input.ownerId,
        requestId: crypto.randomUUID(),
        patternId: input.patternId,
        body: name,
      });
      assert.equal(accepted.kind, "accepted");
      const claimed = await claimNextJob(deps, { patternId: input.patternId });
      assert.equal(claimed.kind, "claimed");
      if (claimed.kind !== "claimed") throw new Error("No execution right");
      const writeSnapshot = async () => {
        if (withHouse) {
          const encoder = new TextEncoder();
          return store.snapshots.write(claimed.right, {
            id: runtime.newId(),
            now: runtime.now(),
            display: bytes,
            house: {
              data: new Uint8Array(
                await readFile(
                  new URL(
                    "../../../../crates/housing/tests/fixtures/two-rooms-before-modifiers.json",
                    import.meta.url,
                  ),
                ),
              ),
              checks: encoder.encode('{"violations":[]}').slice(),
              floorPlans: [
                {
                  storey: "s1",
                  svg: encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>').slice(),
                },
              ],
            },
          });
        }
        const saved = await saveJobSnapshot(deps, { right: claimed.right, display: bytes });
        assert.equal(saved.kind, "saved");
        return saved.snapshot;
      };
      const result = await completeJob(deps, {
        right: claimed.right,
        snapshot: await writeSnapshot(),
        name,
      });
      assert.equal(result.kind, "committed");
      if (result.kind !== "committed") throw new Error("No revision");
      return { revision: result.revision, right: claimed.right };
    };
    const first = await commit(firstDisplay, "初案");
    if (input.kind === "pick") {
      const current = await commit(display, "住宅", true);
      console.log(JSON.stringify({ legacy: first.revision.id, current: current.revision.id }));
    } else {
      assert.equal(first.revision.number, 1);
      assert.equal(first.revision.baseRevisionId, null);
      const second = await commit();
      assert.equal(second.revision.number, 2);
      assert.equal(second.revision.baseRevisionId, first.revision.id);
      const third = await commit();
      assert.equal(third.revision.baseRevisionId, second.revision.id);
      const revisions = [first.revision, second.revision, third.revision];
      let latest = third.revision;
      while (latest.number < 52) {
        const name = latest.number === 51 ? ` ${"a".repeat(100)}` : "案";
        const result = await commit(display, name);
        if (latest.number === 51) assert.equal(result.revision.name, "a".repeat(100));
        latest = result.revision;
        revisions.push(latest);
      }
      const snapshot = await store.revisions.snapshot({
        ownerId: input.ownerId,
        revisionId: first.revision.id,
      });
      assert(snapshot);
      assert.deepEqual(await (await store.snapshots.open(snapshot)).display.read(), firstDisplay);
      const originalDisplay = await bucket.get(
        snapshot.manifestKey.replace(/manifest\.json$/, "display.mdsp"),
      );
      assert(originalDisplay);
      const originalBytes = await originalDisplay.arrayBuffer();
      await assert.rejects(
        store.snapshots.write(first.right, {
          id: snapshot.id,
          now: runtime.now(),
          display: new Uint8Array([1, 2]),
        }),
        /already exists/,
      );
      const unchanged = await bucket.get(originalDisplay.key);
      assert(unchanged);
      assert.deepEqual(await unchanged.arrayBuffer(), originalBytes);
      console.log(JSON.stringify({ revisions }));
    }
  }
} finally {
  await proxy.dispose();
}
