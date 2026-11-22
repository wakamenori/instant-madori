import { z } from "zod";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonical, hash, type Registry, type Candidate, type Rejection } from "./envelope.ts";

const ttl = 24 * 3600_000;
export function openL1Writer<R extends Registry>(file: string, registry: R) {
  const db = new DatabaseSync(file);
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=5000",
    );
    transaction(() => {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) {
        db.exec(readFileSync(join(import.meta.dirname, "migrations/0001_l1.sql"), "utf8"));
      } else if (version === 1) {
        // Older receivers promoted these rows verbatim, including free-form log bodies.
        const held = db
          .prepare(
            "SELECT held_id,source,payload FROM held_record WHERE source IN ('claude.otel.log','codex.otel.log') ORDER BY held_id",
          )
          .all();
        for (const row of held) {
          const spec = registry[String(row.source)];
          if (!spec) throw new Error("Unregistered held log source");
          const payload = canonical(
            spec.sanitize(z.record(z.string(), z.json()).parse(JSON.parse(String(row.payload)))),
          );
          if (payload === row.payload) continue;
          const updated = db
            .prepare("UPDATE OR IGNORE held_record SET payload=?, content_hash=? WHERE held_id=?")
            .run(payload, hash(payload), row.held_id ?? null);
          if (!updated.changes)
            db.prepare("DELETE FROM held_record WHERE held_id=?").run(row.held_id ?? null);
        }
      } else if (version !== 2) throw new Error("Unsupported metrics schema version");
      if (version !== 2) db.exec("PRAGMA user_version=2");
      for (const [source, spec] of Object.entries(registry)) {
        db.prepare("INSERT INTO l1_source VALUES (?,?,?) ON CONFLICT(source) DO NOTHING").run(
          source,
          spec.kind,
          new Date().toISOString(),
        );
        if (db.prepare("SELECT kind FROM l1_source WHERE source=?").get(source)?.kind !== spec.kind)
          throw new Error("Source kind changed");
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const columns =
    "source,kind,source_version,observed_at,occurred_at,natural_key,content_hash,payload";
  const admitted = (subject: string) =>
    !!db.prepare("SELECT 1 FROM admission WHERE subject=?").get(subject);
  function expire(now: string) {
    return db
      .prepare("DELETE FROM held_record WHERE observed_at<=? RETURNING source")
      .all(new Date(Date.parse(now) - ttl).toISOString());
  }
  return {
    admitted,
    expire,
    pendingCodex: () =>
      db
        .prepare(
          "SELECT DISTINCT subject FROM held_record WHERE subject LIKE 'codex.conversation:%'",
        )
        .all()
        .map((row) => String(row.subject).slice("codex.conversation:".length)),
    health: () => db.prepare("SELECT * FROM health_source").all(),
    close: () => db.close(),
    ingest(
      records: readonly Candidate<R>[],
      observedAt: string,
      rejects: readonly Rejection[] = [],
    ) {
      return transaction(() => {
        const tallies: Record<string, Record<string, number>> = {};
        function count(source: string, field: string, n = 1) {
          const tally = (tallies[source] ??= {});
          tally[field] = (tally[field] ?? 0) + n;
        }
        for (const row of expire(observedAt)) count(String(row.source), "expired");
        for (const c of records) {
          const spec = registry[c.source];
          if (!spec) throw new Error("Unregistered source");
          const payload = canonical(spec.sanitize(c.payload)),
            digest = hash(payload);
          const values = [
            c.source,
            spec.kind,
            c.sourceVersion,
            observedAt,
            c.occurredAt,
            c.naturalKey,
            digest,
            payload,
          ];
          if (c.scope.kind === "gated" && !admitted(c.scope.subject)) {
            const row = db
              .prepare(
                `INSERT INTO held_record(subject,${columns}) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source,natural_key,content_hash) DO NOTHING RETURNING held_id`,
              )
              .get(c.scope.subject, ...values);
            count(c.source, row ? "held" : "duplicate");
            continue;
          }
          const prev =
            spec.kind === "observation"
              ? db
                  .prepare(
                    "SELECT ingest_id,content_hash FROM l1_record WHERE source=? AND natural_key=? ORDER BY ingest_id DESC LIMIT 1",
                  )
                  .get(c.source, c.naturalKey)
              : undefined;
          let id = prev?.ingest_id;
          if (prev?.content_hash === digest) count(c.source, "unchanged");
          else {
            const row = db
              .prepare(
                `INSERT INTO l1_record(${columns},prev_ingest_id) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING ingest_id`,
              )
              .get(...values, id ?? null);
            count(c.source, row ? "appended" : "duplicate");
            id =
              row?.ingest_id ??
              db
                .prepare(
                  "SELECT ingest_id FROM l1_record WHERE source=? AND natural_key=? AND content_hash=?",
                )
                .get(c.source, c.naturalKey, digest)?.ingest_id;
          }
          if (c.scope.kind === "proof" && !admitted(c.scope.subject)) {
            db.prepare("INSERT INTO admission VALUES (?,?,?)").run(
              c.scope.subject,
              id ?? null,
              observedAt,
            );
            const promoted = db
              .prepare(
                `INSERT INTO l1_record(${columns}) SELECT ${columns} FROM held_record WHERE subject=? ORDER BY held_id ON CONFLICT DO NOTHING RETURNING source`,
              )
              .all(c.scope.subject);
            for (const row of promoted) count(String(row.source), "promoted");
            db.prepare("DELETE FROM held_record WHERE subject=?").run(c.scope.subject);
          }
        }
        for (const r of rejects) {
          const spec = registry[r.source];
          if (!spec) throw new Error("Unregistered source");
          const row = db
            .prepare(
              "INSERT INTO l1_quarantine(source,observed_at,reason,unit_hash,content) VALUES (?,?,?,?,?) ON CONFLICT(source,unit_hash) DO NOTHING RETURNING quarantine_id",
            )
            .get(
              r.source,
              observedAt,
              r.reason,
              r.unitHash,
              r.content ? canonical(spec.sanitize(r.content)) : null,
            );
          if (row) count(r.source, "quarantined");
        }
        return tallies;
      });
    },
  };
}
