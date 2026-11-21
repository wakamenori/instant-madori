import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { getTestPlatformProxy } from "./platform-proxy.ts";
import { z } from "zod";
import {
  acceptInstruction,
  claimNextJob,
  saveJobSnapshot,
  completeJob,
} from "../../src/services/jobs.ts";
import { createStore } from "../../src/storage/store.ts";
import { d1 } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";
import { accessAssertionHeader } from "@madori/contracts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyAccessToken } from "../../src/api/access.ts";
import { resolveUser } from "../../src/services/users.ts";

const state = z.string().min(1).parse(process.argv[2]);
// getMiniflarePersistRoot takes a literal path; dev appends v3 to --persist-to.
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
    keys: [
      { ...(await exportJWK(publicKey)), kty: "RSA", kid: "conversation-fixture", alg: "RS256" },
    ],
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
      .setProtectedHeader({ alg: "RS256", kid: "conversation-fixture" })
      .setIssuer(user.issuer)
      .setSubject(user.subject)
      .setAudience("conversation-fixture")
      .setExpirationTime("5m")
      .sign(privateKey);
    const identity = await verifyAccessToken(
      new Request("https://app.test/api/me", {
        headers: { [accessAssertionHeader]: token },
      }),
      {
        issuer: user.issuer,
        audience: "conversation-fixture",
        keys: { kind: "local", jwks, source },
      },
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
  const { ownerId, patternId } = await z
    .object({ ownerId: signedInOwner, patternId: z.uuid() })
    .parseAsync(JSON.parse(process.argv[3] ?? ""));
  const now = "2026-11-16T12:00:00.000Z";
  const deps = {
    store,
    runtime: {
      now: () => now,
      newId: () => crypto.randomUUID(),
      newTraceId: () => crypto.randomUUID(),
    },
    wakePattern: async () => {},
  };
  const accepted = await acceptInstruction(deps, {
    ownerId,
    patternId,
    requestId: crypto.randomUUID(),
    body: "instruction",
  });
  assert(accepted.kind === "accepted");
  const claimed = await claimNextJob(deps, { patternId });
  assert(claimed.kind === "claimed");
  const right = claimed.right;
  const display = new Uint8Array(
    await readFile(new URL("../../../../crates/display/tests/two-bodies.mdsp", import.meta.url)),
  );
  const saved = await saveJobSnapshot(deps, { right, display });
  assert(saved.kind === "saved");
  const committed = await completeJob(deps, { right, snapshot: saved.snapshot, name: "初案" });
  assert(committed.kind === "committed");
  const jobId = right.reference.jobId;
  const answerJobId = crypto.randomUUID();
  const ids = [accepted.job.messageId];
  for (let number = 2; number <= 55; number++) {
    const id = crypto.randomUUID();
    ids.push(id);
    const kind =
      ["explanation", "question", "answer", "notice", "instruction"][number - 2] ?? "notice";
    if (kind === "explanation" || kind === "question" || number === 5) {
      await db
        .prepare(
          `INSERT INTO messages (id, pattern_id, owner_id, job_id, number, kind, body, created_at, choices)
        SELECT ?, pattern_id, owner_id, id, ?, ?, ?, ?, ? FROM jobs WHERE id = ?`,
        )
        .bind(id, number, kind, kind, now, kind === "question" ? '["東","南"]' : null, jobId)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO messages (id, pattern_id, owner_id, number, kind, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, patternId, ownerId, number, kind, kind, now)
        .run();
    }
    if (kind === "answer")
      await db
        .prepare(
          `INSERT INTO jobs (id, pattern_id, owner_id, message_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'cancelled', ?, ?)`,
        )
        .bind(answerJobId, patternId, ownerId, id, now, now)
        .run();
  }
  console.log(JSON.stringify({ ids, jobId, answerJobId, now }));
} finally {
  await proxy.dispose();
}
