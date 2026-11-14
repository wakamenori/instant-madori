import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";
import { requestKey } from "../../src/services/requests.ts";
import { commitRevision } from "../../src/services/revisions.ts";
import type { Runtime } from "../../src/services/deps.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";
import { authenticatedUser } from "../../src/owner.ts";
import { StorageCorruption } from "../../src/storage/rows.ts";

const signedInOwner = z
  .uuid()
  .transform((id) => authenticatedUser({ id, email: "fixture@example.test" }).id);

const input = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("commit"),
      ownerId: signedInOwner,
      otherId: signedInOwner,
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
  .parse(JSON.parse(process.argv[3] ?? ""));
const state = z.string().min(1).parse(process.argv[2]);
// getMiniflarePersistRoot takes a literal path; dev appends v3 to --persist-to.
// The HTTP harness has stopped its Worker before launching this process.
const proxy = await getPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
  configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
  persist: { path: join(state, "v3") },
  remoteBindings: false,
});
try {
  const { DB: db, BLOBS: bucket } = proxy.env;
  const store = createStore(d1(db), r2(bucket));
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
    await assert.rejects(store.snapshots.display(snapshot), StorageCorruption);
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
    const deps = { store, runtime };
    const commit = (baseRevisionId: string | null, ownerId = input.ownerId, name = "案") =>
      commitRevision(deps, { ownerId, patternId: input.patternId, baseRevisionId, name, display });
    const count = async (table: "snapshots" | "revisions") =>
      db.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
    const first = await commitRevision(deps, {
      ownerId: input.ownerId,
      patternId: input.patternId,
      baseRevisionId: null,
      name: "初案",
      display: firstDisplay,
    });
    assert.equal(first.kind, "committed");
    if (first.kind !== "committed") throw new Error("No first revision");
    assert.equal(first.revision.number, 1);
    assert.equal(first.revision.baseRevisionId, null);
    const second = await commit(first.revision.id);
    assert.equal(second.kind, "committed");
    if (second.kind !== "committed") throw new Error("No second revision");
    assert.equal(second.revision.number, 2);
    assert.equal(second.revision.baseRevisionId, first.revision.id);
    const before = [await count("snapshots"), await count("revisions")];
    assert.deepEqual(await commit(first.revision.id), { kind: "base_mismatch" });
    assert.deepEqual(await commit(null), { kind: "base_mismatch" });
    assert.deepEqual(await commit(second.revision.id, input.otherId), { kind: "not_found" });
    assert.deepEqual([await count("snapshots"), await count("revisions")], before);
    const missing = await commitRevision(deps, {
      ownerId: input.ownerId,
      patternId: crypto.randomUUID(),
      baseRevisionId: null,
      name: "案",
      display,
    });
    assert.deepEqual(missing, { kind: "not_found" });
    const racers = await Promise.all([commit(second.revision.id), commit(second.revision.id)]);
    assert.equal(racers.filter((r) => r.kind === "committed").length, 1);
    assert.equal(racers.filter((r) => r.kind === "base_mismatch").length, 1);
    assert.equal(await count("snapshots"), 3);
    assert.equal(await count("revisions"), 3);
    const winner = racers.find((r) => r.kind === "committed");
    assert(winner?.kind === "committed");
    const revisions = [first.revision, second.revision, winner.revision];
    assert.equal(winner.revision.number, 3);
    let latest = winner.revision;
    while (latest.number < 52) {
      // Stored untrimmed, this name would be 101 characters and fail the CHECK constraint.
      const name = latest.number === 51 ? ` ${"a".repeat(100)}` : "案";
      const result = await commit(latest.id, input.ownerId, name);
      assert(result.kind === "committed");
      if (latest.number === 51) assert.equal(result.revision.name, "a".repeat(100));
      latest = result.revision;
      revisions.push(latest);
    }
    const snapshot = await store.revisions.snapshot({
      ownerId: input.ownerId,
      revisionId: first.revision.id,
    });
    assert(snapshot);
    assert.deepEqual((await store.snapshots.display(snapshot)).bytes, firstDisplay);
    const originalDisplay = await bucket.get(
      snapshot.manifestKey.replace(/manifest\.json$/, "display.mdsp"),
    );
    assert(originalDisplay);
    const originalBytes = await originalDisplay.arrayBuffer();
    await assert.rejects(
      store.snapshots.write({
        id: snapshot.id,
        ownerId: input.ownerId,
        now: runtime.now(),
        display: new Uint8Array([1, 2]),
      }),
      /already exists/,
    );
    const unchanged = await bucket.get(originalDisplay.key);
    assert(unchanged);
    assert.deepEqual(await unchanged.arrayBuffer(), originalBytes);
    const counts = [await count("snapshots"), await count("revisions")];
    for (const name of ["", " ", "\u200b", "a\u0007"]) {
      assert.deepEqual(await commit(latest.id, input.ownerId, name), { kind: "invalid_name" });
    }
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    const fresh = () =>
      store.snapshots.write({
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        now: runtime.now(),
        display,
      });
    // A failing revision insert must also roll back its preceding snapshot insert.
    await assert.rejects(
      store.revisions.commit({
        id: crypto.randomUUID(),
        patternId: input.patternId,
        name: "",
        baseRevisionId: latest.id,
        snapshot: await fresh(),
      }),
      /CHECK constraint failed/,
    );
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    const foreignSnapshot = await store.snapshots.write({
      id: crypto.randomUUID(),
      ownerId: input.otherId,
      now: runtime.now(),
      display,
    });
    assert.deepEqual(
      await store.revisions.commit({
        id: crypto.randomUUID(),
        patternId: input.patternId,
        name: "案",
        baseRevisionId: latest.id,
        snapshot: foreignSnapshot,
      }),
      { kind: "not_committed" },
    );
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    // An already stored snapshot skips the snapshot insert; the base must still hold.
    assert.deepEqual(
      await store.revisions.commit({
        id: crypto.randomUUID(),
        patternId: input.patternId,
        name: "案",
        baseRevisionId: first.revision.id,
        snapshot: { ...snapshot, ownerId: input.ownerId },
      }),
      { kind: "not_committed" },
    );
    assert.deepEqual([await count("snapshots"), await count("revisions")], counts);
    console.log(JSON.stringify({ revisions }));
  }
} finally {
  await proxy.dispose();
}
