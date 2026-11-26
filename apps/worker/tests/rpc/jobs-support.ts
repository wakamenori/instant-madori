import assert from "node:assert/strict";
import { acceptInstruction, claimNextJob } from "../../src/services/jobs.ts";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { unstable_splitSqlQuery } from "wrangler";
import { getTestPlatformProxy } from "./platform-proxy.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessAssertionHeader } from "@madori/contracts";
import { verifyAccessToken } from "../../src/api/access.ts";
import { resolveUser } from "../../src/services/users.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";

export const jobMigration = new URL("../../migrations/0003_jobs_messages.sql", import.meta.url);
export const queueHoldMigration = new URL("../../migrations/0004_queue_hold.sql", import.meta.url);
export const conversationMigration = new URL(
  "../../migrations/0005_conversation_kinds.sql",
  import.meta.url,
);
export const aiAttemptsMigration = new URL(
  "../../migrations/0006_ai_attempts.sql",
  import.meta.url,
);
export const snapshotMigration = new URL(
  "../../migrations/0007_snapshot_format_2.sql",
  import.meta.url,
);
export async function applyJobMigrations(db: Awaited<ReturnType<typeof openJobDatabase>>) {
  for (const migration of [
    jobMigration,
    queueHoldMigration,
    conversationMigration,
    aiAttemptsMigration,
    snapshotMigration,
  ])
    await db.apply(await readFile(migration, "utf8"));
}
export const now = "2026-11-15T00:00:00.000Z";

export async function openJobDatabase() {
  const proxy = await getTestPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
    configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
  });
  const raw = proxy.env.DB;
  const apply = (sql: string) => raw.batch(unstable_splitSqlQuery(sql).map((s) => raw.prepare(s)));
  try {
    for (const name of ["0001_users_projects_patterns.sql", "0002_revisions.sql"]) {
      await apply(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
    }
    const store = createStore(d1(raw), r2(proxy.env.BLOBS));
    const runtime = {
      now: () => now,
      newId: () => crypto.randomUUID(),
      newTraceId: () => crypto.randomUUID(),
    };
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwks = {
      keys: [{ ...(await exportJWK(publicKey)), kty: "RSA", kid: "jobs", alg: "RS256" }],
    };
    const issuer = "https://jobs.invalid";
    async function owner(subject: string) {
      const token = await new SignJWT({ email: `${subject}@example.test` })
        .setProtectedHeader({ alg: "RS256", kid: "jobs" })
        .setIssuer(issuer)
        .setAudience("jobs")
        .setSubject(subject)
        .setExpirationTime("5m")
        .sign(privateKey);
      const identity = await verifyAccessToken(
        new Request("https://app.test/api/me", { headers: { [accessAssertionHeader]: token } }),
        { issuer, audience: "jobs", keys: { kind: "local", jwks, source: JSON.stringify(jwks) } },
      );
      return (await resolveUser({ store, runtime }, identity)).id;
    }
    return {
      raw,
      bucket: proxy.env.BLOBS,
      store,
      runtime,
      apply,
      owner,
      dispose: () => proxy.dispose(),
    };
  } catch (error) {
    await proxy.dispose();
    throw error;
  }
}

export async function snapshotPattern(db: Awaited<ReturnType<typeof openJobDatabase>>) {
  const ownerId = await db.owner("snapshot");
  const patternId = crypto.randomUUID();
  const created = await db.store.projects.createOnce(
    {
      ownerId,
      requestId: crypto.randomUUID(),
      operation: "project.create",
      fingerprint: "fixture",
    },
    {
      id: crypto.randomUUID(),
      name: "P",
      now,
      firstPattern: { id: patternId, name: "T", defaultNamePrefix: "T" },
    },
  );
  assert.equal(created.kind, "applied");
  const deps = { ...db, wakePattern: async () => {} };
  async function claim() {
    const accepted = await acceptInstruction(deps, {
      ownerId,
      patternId,
      requestId: crypto.randomUUID(),
      body: "案を作って",
    });
    assert.equal(accepted.kind, "accepted");
    const job = await claimNextJob(deps, { patternId });
    assert(job.kind === "claimed");
    return job.right;
  }
  async function snapshot(revisionId: string) {
    const row = await db.store.revisions.snapshot({ ownerId, revisionId });
    assert(row);
    return row;
  }
  return { ownerId, patternId, claim, snapshot };
}
