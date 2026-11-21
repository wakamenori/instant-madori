import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registry } from "./sources.ts";
import { openL1Writer } from "./store.ts";
import { hash, type Candidate, type Obj } from "./envelope.ts";
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
  const reject = { source: "event", reason: "bad", unitHash: hash("bad unit"), content: null };
  assert.deepEqual(store.ingest([], at, [reject, reject, { ...reject, unitHash: hash("other") }]), {
    event: { quarantined: 2 },
  });
  assert.throws(() =>
    store.ingest(
      [
        { ...obs, naturalKey: "rollback" },
        { ...obs, naturalKey: "" },
      ],
      at,
    ),
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM l1_record WHERE natural_key='rollback'").get()?.n,
    0,
  );
  const observation =
    "INSERT INTO l1_record(source,kind,source_version,observed_at,natural_key,content_hash,payload,prev_ingest_id) VALUES ('state','observation','1',?,'x',?,'{}',?)";
  const first = db
    .prepare(
      "SELECT ingest_id,content_hash FROM l1_record WHERE kind='observation' ORDER BY ingest_id LIMIT 1",
    )
    .get();
  assert.ok(first);
  assert.throws(() => db.prepare(observation).run(at, hash("four"), null), /UNIQUE/u);
  assert.throws(
    () => db.prepare(observation).run(at, hash("four"), first.ingest_id ?? null),
    /UNIQUE/u,
  );
  assert.throws(
    () => db.prepare(observation).run(at, first.content_hash ?? null, first.ingest_id ?? null),
    /must change/u,
  );
  assert.throws(() => db.prepare(observation).run(at, hash("four"), 999), /must change/u);
  for (const [table, column] of [
    ["l1_record", "source"],
    ["l1_source", "source"],
    ["admission", "subject"],
    ["l1_quarantine", "source"],
  ] as const) {
    assert.throws(
      () => db.exec("UPDATE " + table + " SET " + column + "=" + column),
      /append-only/u,
    );
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

  assert.throws(() => openL1Writer(file, { state: { kind: "event", sanitize } }), /kind changed/u);
  db.exec("PRAGMA user_version=3");
  assert.throws(() => openL1Writer(file, registry), /Unsupported/u);
});

void test("upgrading held logs removes old bodies and deduplicates the sanitized content", (t) => {
  const root = mkdtempSync(join(tmpdir(), "held-logs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "db");
  const old = openL1Writer(file, {
    "claude.otel.log": { kind: "event", sanitize: (p: Obj) => p },
  } as const);
  const at = new Date().toISOString();
  for (const text of ["first private text", "second private text"])
    old.ingest(
      [
        {
          source: "claude.otel.log",
          sourceVersion: "1",
          scope: { kind: "gated", subject: "session:x" },
          occurredAt: at,
          naturalKey: "x",
          payload: { log_record: { body: { stringValue: text } } },
        },
      ],
      at,
    );
  old.close();
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec("PRAGMA user_version=1");
  openL1Writer(file, registry).close();
  assert.deepEqual(
    { ...db.prepare("SELECT count(*) n,payload,content_hash FROM held_record").get() },
    { n: 1, payload: '{"log_record":{}}', content_hash: hash('{"log_record":{}}') },
  );
});
