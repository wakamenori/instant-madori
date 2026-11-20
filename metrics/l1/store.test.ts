import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openL1Writer } from "./store.ts";
import type { Candidate, Obj } from "./envelope.ts";
void test("retries, state transitions, promotion and expiry survive reopening", (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "metrics-")), "db");
  t.after(() => rmSync(join(file, ".."), { force: true, recursive: true }));
  const sanitize = (p: Obj) => ({ n: p.n ?? 0 });
  const registry = {
    state: { kind: "observation", sanitize },
    event: { kind: "event", sanitize },
  } as const;
  const store = openL1Writer(file, registry);
  t.after(() => store.close());
  const at = "2026-01-01T00:00:00.000Z";
  const base = {
    sourceVersion: "1",
    occurredAt: null,
    naturalKey: "x",
    payload: { n: 1, secret: "omit" },
  };
  const obs = { ...base, scope: { kind: "repo" }, source: "state" } as const;
  const event: Candidate<typeof registry> = {
    ...base,
    scope: { kind: "gated", subject: "test:x" },
    source: "event",
  };
  assert.deepEqual(store.ingest([obs, obs, { ...obs, payload: { n: 2 } }, obs, event, event], at), {
    state: { appended: 3, unchanged: 1 },
    event: { held: 1, duplicate: 1 },
  });
  const proof = {
    ...event,
    naturalKey: "proof",
    scope: { kind: "proof", subject: "test:x" },
  } as const;
  assert.deepEqual(store.ingest([proof, event], at), {
    event: { appended: 1, promoted: 1, duplicate: 1 },
  });
  store.ingest([{ ...event, naturalKey: "y", scope: { kind: "gated", subject: "test:y" } }], at);
  assert.equal(store.expire("2026-01-02T00:00:00.000Z").length, 1);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM l1_record WHERE payload LIKE '%secret%'").get()?.n,
    0,
  );
  db.exec("PRAGMA foreign_keys=ON");
  for (const table of ["l1_record", "l1_source", "admission"]) {
    assert.throws(() => db.exec("DELETE FROM " + table), /append-only/u);
  }
  for (const [col, value] of Object.entries({
    source: "'absent'",
    kind: "'unknown'",
    natural_key: "''",
    source_version: "''",
    payload: "'[]'",
    content_hash: "'z'",
    observed_at: "'now'",
    occurred_at: "'now'",
    prev_ingest_id: "1",
  })) {
    const cols = [
      "source",
      "kind",
      "source_version",
      "natural_key",
      "payload",
      "content_hash",
      "observed_at",
      "occurred_at",
      "prev_ingest_id",
    ];
    assert.throws(() =>
      db.exec(
        `INSERT INTO l1_record(${cols.join(",")}) SELECT ${cols.map((k) => (k === col ? value : k === "natural_key" ? "'new'" : k)).join(",")} FROM l1_record WHERE kind='event' LIMIT 1`,
      ),
    );
  }
  assert.throws(() => db.exec("UPDATE l1_record SET payload='{}'"), /append-only/u);
  assert.throws(() => openL1Writer(file, { state: { kind: "event", sanitize } }), /kind changed/u);
});
