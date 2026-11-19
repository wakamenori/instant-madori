import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { acceptInstruction } from "../../src/services/jobs.ts";
import { requestKey } from "../../src/services/requests.ts";
import type { OwnerId } from "../../src/owner.ts";
import { openJobDatabase, jobMigration, now } from "./jobs-support.ts";

await test("Instruction acceptance on real D1", async (t) => {
  const db = await openJobDatabase();
  t.after(() => db.dispose());
  await db.apply(await readFile(jobMigration, "utf8"));
  const ownerId = await db.owner("owner");
  const otherId = await db.owner("other");
  const deps = { store: db.store, runtime: db.runtime, wakePattern: async () => {} };
  async function pattern(owner = ownerId) {
    const result = await db.store.projects.createOnce(
      {
        ownerId: owner,
        requestId: crypto.randomUUID(),
        operation: "project.create",
        fingerprint: "fixture",
      },
      {
        id: crypto.randomUUID(),
        name: "P",
        now,
        firstPattern: { id: crypto.randomUUID(), name: "T", defaultNamePrefix: "T" },
      },
    );
    assert.equal(result.kind, "applied");
    if (result.kind !== "applied") throw new Error("No pattern");
    return result.result.pattern.id;
  }
  const patternId = await pattern();
  const foreignPattern = await pattern(otherId);
  const counts = () =>
    Promise.all(
      ["messages", "jobs", "requests"].map((table) =>
        db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
      ),
    );
  const input = (body = "間取りを作って", target = patternId, owner: OwnerId = ownerId) => ({
    ownerId: owner,
    requestId: crypto.randomUUID(),
    patternId: target,
    body,
  });

  await t.test("a resend returns the exact acceptance, even after the job progresses", async () => {
    const request = input(" \t間取りを作って\n　");
    const before = await counts();
    const first = await acceptInstruction(deps, request);
    assert.equal(first.kind, "accepted");
    if (first.kind !== "accepted") throw new Error("Not accepted");
    assert.equal(first.message.number, 1);
    assert.equal(first.message.body, request.body);
    assert.equal(first.job.messageId, first.message.id);
    assert.equal(first.job.state, "queued");
    assert.equal(first.job.generation, 0);
    assert.equal(first.job.baseRevisionId, null);
    assert.equal(first.acceptance, "applied");
    assert.deepEqual(await acceptInstruction(deps, request), { ...first, acceptance: "replayed" });
    await db.raw
      .prepare("UPDATE jobs SET state = 'running', generation = 1 WHERE id = ?")
      .bind(first.job.id)
      .run();
    assert.deepEqual(await acceptInstruction(deps, request), { ...first, acceptance: "replayed" });
    const record = await db.raw
      .prepare("SELECT result FROM requests WHERE owner_id = ? AND request_id = ?")
      .bind(ownerId, request.requestId)
      .first("result");
    assert.equal(record, JSON.stringify({ message: first.message, job: first.job }));
    const after = await counts();
    assert.deepEqual(
      after,
      before.map((n) => Number(n) + 1),
    );
    for (const changed of [
      { ...request, body: "別の指示" },
      { ...request, patternId: foreignPattern },
    ]) {
      assert.deepEqual(await acceptInstruction(deps, changed), { kind: "request_id_reused" });
    }
    assert.deepEqual(await counts(), after);
  });
  await t.test(
    "twenty concurrent identical requests create one message and one queued job",
    async () => {
      const target = await pattern();
      const request = input("同時再送", target);
      const key = await requestKey(ownerId, request.requestId, "instruction.accept", {
        patternId: target,
        body: request.body,
      });
      const before = await counts();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          db.store.jobs.acceptOnce(key, {
            id: crypto.randomUUID(),
            messageId: crypto.randomUUID(),
            patternId: target,
            body: request.body,
            now,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.kind === "applied").length, 1);
      assert.equal(results.filter((r) => r.kind === "replayed").length, 19);
      const applied = results.find((r) => r.kind === "applied");
      assert(applied?.kind === "applied");
      for (const result of results) {
        assert(result.kind === "applied" || result.kind === "replayed");
        assert.deepEqual(result.result, applied.result);
      }
      assert.deepEqual(await acceptInstruction(deps, request), {
        kind: "accepted",
        acceptance: "replayed",
        ...applied.result,
      });
      assert.deepEqual(
        await counts(),
        before.map((n) => Number(n) + 1),
      );
    },
  );
  await t.test("fifty distinct concurrent requests receive consecutive numbers", async () => {
    const target = await pattern();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => acceptInstruction(deps, input(`指示${i}`, target))),
    );
    const numbers = results.map((result) => {
      assert.equal(result.kind, "accepted");
      if (result.kind !== "accepted") throw new Error("Not accepted");
      return result.message.number;
    });
    assert.deepEqual(
      numbers.sort((a, b) => a - b),
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    const rows = await db.raw
      .prepare(
        `SELECT count(*) AS n FROM jobs j JOIN messages m ON m.id = j.message_id
      WHERE j.pattern_id = ? AND j.state = 'queued'`,
      )
      .bind(target)
      .first("n");
    assert.equal(rows, 50);
  });
  await t.test(
    "foreign and missing patterns return not_found without recording anything",
    async () => {
      const before = await counts();
      for (const request of [
        input("指示", foreignPattern),
        input("指示", crypto.randomUUID()),
        input("指示", patternId, otherId),
      ]) {
        assert.deepEqual(await acceptInstruction(deps, request), { kind: "not_found" });
      }
      assert.deepEqual(await counts(), before);
    },
  );
  await t.test(
    "invalid Unicode, whitespace-only text, and excess UTF-8 bytes have no effects",
    async () => {
      const before = await counts();
      const whitespace = [
        9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200,
        8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
      ];
      for (const body of [
        "",
        " ",
        "　",
        "\t\n",
        ...whitespace.map((c) => String.fromCodePoint(c)),
        "x\ud800y",
        "x\udc00y",
        "a".repeat(16385),
        "あ".repeat(5461) + "aa",
        "😀".repeat(4096) + "a",
      ]) {
        assert.deepEqual(await acceptInstruction(deps, input(body)), { kind: "invalid_message" });
      }
      assert.deepEqual(await counts(), before);
      for (const body of [
        "a".repeat(16384),
        "あ".repeat(5461) + "a",
        "😀".repeat(4096),
        "\u0085\u200b",
      ]) {
        const request = input(body);
        const result = await acceptInstruction(deps, request);
        assert.equal(result.kind, "accepted");
        assert.deepEqual(await acceptInstruction(deps, request), {
          ...result,
          acceptance: "replayed",
        });
        if (result.kind !== "accepted") throw new Error("Not accepted");
        assert.equal(
          await db.raw
            .prepare("SELECT body FROM messages WHERE id = ?")
            .bind(result.message.id)
            .first("body"),
          body,
        );
      }
    },
  );
  await t.test(
    "a failure after inserting a message rolls back the complete acceptance",
    async () => {
      const accepted = await acceptInstruction(deps, input());
      assert.equal(accepted.kind, "accepted");
      if (accepted.kind !== "accepted") throw new Error("Not accepted");
      const before = await counts();
      let next = 0;
      const runtime = {
        ...db.runtime,
        newId: () => (next++ === 0 ? accepted.job.id : crypto.randomUUID()),
      };
      const request = input("rollback");
      await assert.rejects(
        acceptInstruction({ store: db.store, runtime, wakePattern: async () => {} }, request),
        /UNIQUE constraint failed/,
      );
      assert.deepEqual(await counts(), before);
      assert.equal((await acceptInstruction(deps, request)).kind, "accepted");
    },
  );
});
