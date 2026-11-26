import { legacySnapshot } from "./snapshot-support.ts";
import assert from "node:assert/strict";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { getTestPlatformProxy } from "./platform-proxy.ts";
import { z } from "zod";
import { acceptInstruction, claimNextJob, completeJob } from "../../src/services/jobs.ts";
import type { Runtime } from "../../src/services/deps.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";
import { accessAssertionHeader } from "@madori/contracts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyAccessToken } from "../../src/api/access.ts";
import { resolveUser } from "../../src/services/users.ts";

const pausedWorkerState = z.string().min(1).parse(process.argv[2]);
// getMiniflarePersistRoot takes a literal path; dev appends v3 to --persist-to.
const proxy = await getTestPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
  configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
  persist: { path: join(pausedWorkerState, "v3") },
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
    .object({
      kind: z.enum(["seed", "overlap", "rows", "queued", "orphaned"]),
      ownerId: signedInOwner,
      patternId: z.uuid(),
    })
    .parseAsync(JSON.parse(process.argv[3] ?? ""));
  const ageMs = input.kind === "queued" || input.kind === "orphaned" ? 600_000 : 0;
  const runtime: Runtime = {
    now: () => new Date(Date.now() - ageMs).toISOString(),
    newId: () => crypto.randomUUID(),
    newTraceId: () => crypto.randomUUID(),
  };
  const deps = { store, runtime, wakePattern: async () => {} };
  const accept = async () => {
    const accepted = await acceptInstruction(deps, {
      ownerId: input.ownerId,
      patternId: input.patternId,
      requestId: crypto.randomUUID(),
      body: "fixture",
    });
    assert(accepted.kind === "accepted");
    return accepted.job;
  };
  if (input.kind === "rows") {
    const rows = await db
      .prepare(
        "SELECT j.id AS jobId, j.state, j.generation, j.updated_at AS updatedAt, j.holds_queue AS holdsQueue FROM jobs j JOIN messages m ON m.id = j.message_id WHERE j.pattern_id = ? ORDER BY m.number",
      )
      .bind(input.patternId)
      .all();
    console.log(JSON.stringify(rows.results));
  } else if (input.kind === "queued" || input.kind === "orphaned") {
    const job = await accept();
    if (input.kind === "orphaned")
      assert.equal((await claimNextJob(deps, { patternId: input.patternId })).kind, "claimed");
    console.log(JSON.stringify(job));
  } else if (input.kind === "overlap") {
    const jobs = [await accept(), await accept()];
    assert.equal((await claimNextJob(deps, { patternId: input.patternId })).kind, "claimed");
    console.log(JSON.stringify(jobs));
  } else {
    const revisions = [];
    for (let i = 0; i < 2; i++) {
      await accept();
      const claimed = await claimNextJob(deps, { patternId: input.patternId });
      assert(claimed.kind === "claimed");
      const snapshot = await legacySnapshot(
        bucket,
        claimed.right,
        new Uint8Array([1, 2, 3]),
        runtime.now(),
      );
      const done = await completeJob(deps, {
        explanation: "fixture",
        right: claimed.right,
        name: `seed ${i}`,
        snapshot,
      });
      assert(done.kind === "committed");
      revisions.unshift(done.revision);
    }
    console.log(JSON.stringify(revisions));
  }
} finally {
  await proxy.dispose();
}
