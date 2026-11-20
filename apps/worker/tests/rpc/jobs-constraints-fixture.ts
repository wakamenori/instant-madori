import assert from "node:assert/strict";
import { jobStateSchema, holdingJobStates } from "../../src/storage/job-states.ts";
import { test } from "node:test";
import { openJobDatabase, applyJobMigrations, now } from "./jobs-support.ts";

await test("Job, message, and revision constraints on D1", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await applyJobMigrations(db);
  await db.apply(`
    INSERT INTO users VALUES ('u1','https://a.invalid','s1','a@example.test','${now}'),
      ('u2','https://a.invalid','s2','b@example.test','${now}');
    INSERT INTO projects VALUES ('p1','u1','P',1,3,'${now}','${now}'),
      ('p2','u2','P',1,2,'${now}','${now}');
    INSERT INTO patterns VALUES ('t1','p1','u1',1,'T',1,'${now}','${now}'),
      ('t2','p1','u1',2,'T',1,'${now}','${now}'),
      ('t3','p2','u2',1,'T',1,'${now}','${now}');
    INSERT INTO snapshots VALUES ('s1','u1',1,'manifest','${"a".repeat(64)}','${now}');
    INSERT INTO revisions
      (id,pattern_id,owner_id,number,name,snapshot_id,base_revision_id,created_at)
      VALUES ('r1','t1','u1',1,'R','s1',NULL,'${now}'),
        ('r2','t1','u1',2,'R','s1','r1','${now}'),
        ('r3','t2','u1',1,'R','s1',NULL,'${now}');
  `);
  let sequence = 0;
  const message = (id: string, pattern = "t1", owner = "u1", body = "指示", number = ++sequence) =>
    db.raw
      .prepare(
        "INSERT INTO messages (id,pattern_id,owner_id,number,body,created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(id, pattern, owner, number, body, now)
      .run();
  async function job(
    id: string,
    state = "queued",
    pattern = "t1",
    owner = "u1",
    base: string | null = "r1",
  ) {
    const messageId = `m-${id}`;
    await message(messageId, pattern, pattern === "t3" ? "u2" : "u1");
    return db.raw
      .prepare(
        `INSERT INTO jobs
      (id,pattern_id,owner_id,message_id,state,generation,base_revision_id,created_at,updated_at)
      VALUES (?,?,?,?,?,0,?,?,?)`,
      )
      .bind(id, pattern, owner, messageId, state, base, now, now)
      .run();
  }
  await t.test("hold CHECK matches state roles and one job per pattern may hold", async () => {
    await job("holder");
    for (const state of jobStateSchema.options) {
      const update = db.raw
        .prepare("UPDATE jobs SET state = ?, holds_queue = 1 WHERE id = 'holder'")
        .bind(state);
      if (holdingJobStates.includes(`'${state}'`)) await update.run();
      else await assert.rejects(update.run(), /CHECK constraint/);
    }
    await job("second-holder", "failed");
    await assert.rejects(
      db.raw.prepare("UPDATE jobs SET holds_queue = 1 WHERE id = 'second-holder'").run(),
      /UNIQUE constraint/,
    );
    await job("foreign-holder", "failed", "t2", "u1", "r3");
    await db.raw.prepare("UPDATE jobs SET holds_queue = 1 WHERE id = 'foreign-holder'").run();
  });
  const revision = (
    id: string,
    jobId: string,
    base: string | null = "r1",
    pattern = "t1",
    conversation: number | null = null,
  ) =>
    db.raw
      .prepare(
        `INSERT INTO revisions
      (id,pattern_id,owner_id,number,name,snapshot_id,base_revision_id,created_at,job_id,conversation_number)
      VALUES (?,?,'u1',?,'R','s1',?,?,?,?)`,
      )
      .bind(id, pattern, ++sequence, base, now, jobId, conversation)
      .run();

  await t.test("every active state competes for the same pattern slot", async () => {
    await job("active");
    for (const first of ["running", "validating", "committing"]) {
      await db.raw.prepare("UPDATE jobs SET state = ? WHERE id = 'active'").bind(first).run();
      for (const second of ["running", "validating", "committing"]) {
        await assert.rejects(
          job(`conflict-${first}-${second}`, second),
          /UNIQUE constraint failed/,
        );
      }
    }
    await job("other-active", "running", "t2", "u1", "r3");
    await db.raw.prepare("UPDATE jobs SET state = 'completed' WHERE id = 'active'").run();
    await job("next-active", "running");
    await db.raw.prepare("UPDATE jobs SET state = 'completed' WHERE id = 'next-active'").run();
  });
  await t.test(
    "all nine planned states and multiple queued rows are allowed, others are rejected",
    async () => {
      for (const state of [
        "queued",
        "running",
        "validating",
        "committing",
        "completed",
        "awaiting_answer",
        "cancelled",
        "failed",
        "limited",
      ]) {
        await job(`state-${state}`, state);
        await db.raw
          .prepare("UPDATE jobs SET state = 'completed' WHERE id = ?")
          .bind(`state-${state}`)
          .run();
      }
      await job("queue-one");
      await job("queue-two");
      await assert.rejects(job("invalid", "invented"), /CHECK constraint failed/);
      await assert.rejects(
        db.raw.prepare("UPDATE jobs SET state = 'invented' WHERE id = 'queue-one'").run(),
        /CHECK constraint failed/,
      );
      await assert.rejects(
        db.raw.prepare("UPDATE jobs SET generation = -1 WHERE id = 'queue-one'").run(),
        /CHECK constraint failed/,
      );
    },
  );
  await t.test("ownership and same-pattern links are enforced", async () => {
    await assert.rejects(message("foreign-message", "t1", "u2"), /FOREIGN KEY constraint failed/);
    await assert.rejects(job("foreign-job", "queued", "t1", "u2"), /FOREIGN KEY constraint failed/);
    await assert.rejects(
      job("foreign-base", "queued", "t1", "u1", "r3"),
      /FOREIGN KEY constraint failed/,
    );
    await message("unassigned-other-message", "t2");
    await assert.rejects(
      db.raw
        .prepare("UPDATE jobs SET message_id = 'unassigned-other-message' WHERE id = 'queue-one'")
        .run(),
      /FOREIGN KEY constraint failed/,
    );
    await job("other-initial", "queued", "t2", "u1", null);
    await assert.rejects(
      revision("wrong-pattern", "other-initial", null),
      /FOREIGN KEY constraint failed/,
    );
  });
  await t.test(
    "one revision per job, with the same non-null base and a valid conversation boundary",
    async () => {
      await revision("result", "queue-one");
      await assert.rejects(revision("duplicate-result", "queue-one"), /UNIQUE constraint failed/);
      await assert.rejects(
        revision("wrong-base", "queue-two", "r2"),
        /FOREIGN KEY constraint failed/,
      );
      await assert.rejects(
        revision("missing-boundary", "queue-two", "r1", "t1", 999999),
        /FOREIGN KEY constraint failed/,
      );
      await assert.rejects(
        revision("zero-boundary", "queue-two", "r1", "t1", 0),
        /CHECK constraint failed/,
      );
      await revision("boundary", "queue-two", "r1", "t1", 1);
    },
  );
  await t.test("job and revision bases agree including NULL in either direction", async () => {
    await job("non-null-base");
    await assert.rejects(
      revision("null-result-base", "non-null-base", null),
      /FOREIGN KEY constraint failed/,
    );
    await job("null-base", "queued", "t1", "u1", null);
    await assert.rejects(
      revision("non-null-result-base", "null-base", "r1"),
      /FOREIGN KEY constraint failed/,
    );
    await revision("null-initial-result", "null-base", null);
    await revision("matching-result", "non-null-base", "r1");
    await assert.rejects(
      db.raw.prepare("UPDATE jobs SET base_revision_id = NULL WHERE id = 'non-null-base'").run(),
      /FOREIGN KEY constraint failed/,
    );
    await assert.rejects(
      db.raw
        .prepare("UPDATE revisions SET base_revision_id = 'r1' WHERE id = 'null-initial-result'")
        .run(),
      /FOREIGN KEY constraint failed/,
    );
  });
  await t.test("message numbers are unique within a pattern", async () => {
    await message("unique", "t1", "u1", "a", 10000);
    await assert.rejects(message("duplicate", "t1", "u1", "a", 10000), /UNIQUE constraint failed/);
    await message("independent", "t2", "u1", "a", 10000);
    await assert.rejects(message("zero", "t1", "u1", "a", 0), /CHECK constraint failed/);
  });
  await t.test("D1 rejects whitespace-only text and matches UTF-8 byte boundaries", async () => {
    const whitespace = [
      9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
      8202, 8232, 8233, 8239, 8287, 12288, 65279,
    ];
    for (const body of ["", " \t\n", ...whitespace.map((c) => String.fromCodePoint(c))]) {
      await assert.rejects(
        message(`blank-${++sequence}`, "t1", "u1", body),
        /CHECK constraint failed/,
      );
    }
    for (const body of ["a".repeat(16384), "あ".repeat(5461) + "a", "😀".repeat(4096)]) {
      await message(`limit-${++sequence}`, "t1", "u1", body);
      await assert.rejects(
        message(`over-${++sequence}`, "t1", "u1", body + "a"),
        /CHECK constraint failed/,
      );
    }
    await message("not-trimmed", "t1", "u1", " \t指示\n　");
    await message("not-js-whitespace", "t1", "u1", "\u0085\u200b");
  });
  assert.deepEqual((await db.raw.prepare("PRAGMA foreign_key_check").all()).results, []);
});
