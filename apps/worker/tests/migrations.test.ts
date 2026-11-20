import assert from "node:assert/strict";
import { test } from "node:test";
import { migratedDatabase } from "./support/local-worker.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

await test("Queue hold migration preserves populated queues and previous Worker writes", async () => {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("./rpc/queue-hold-migration-fixture.ts", import.meta.url)),
  ]);
});

await test("Populated migration preserves bases and the previous Worker's storage operations", async () => {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("./rpc/jobs-migration-fixture.ts", import.meta.url)),
  ]);
});

await test("Jobs and messages enforce their D1 constraints", async () => {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("./rpc/jobs-constraints-fixture.ts", import.meta.url)),
  ]);
});

await test("Schema constraints", async (t) => {
  const db = await migratedDatabase();
  t.after(() => db.remove());
  const now = "2026-11-13T00:00:00.000Z";
  await db.execute(
    `INSERT INTO users (id, access_issuer, access_subject, email, created_at) VALUES
       ('u1', 'https://a.invalid', 's1', 'one@example.com', '${now}'),
       ('u2', 'https://a.invalid', 's2', 'two@example.com', '${now}');
     INSERT INTO projects (id, owner_id, name, version, next_pattern_number, created_at, updated_at)
       VALUES ('p1', 'u1', 'P', 1, 1, '${now}', '${now}');`,
  );

  await t.test("a pattern must have the same owner as its project", async () => {
    await assert.rejects(
      db.execute(
        `INSERT INTO patterns (id, project_id, owner_id, number, name, version, created_at, updated_at)
         VALUES ('t1', 'p1', 'u2', 1, 'T', 1, '${now}', '${now}')`,
      ),
      /FOREIGN KEY constraint failed/,
    );
    await db.execute(
      `INSERT INTO patterns (id, project_id, owner_id, number, name, version, created_at, updated_at)
       VALUES ('t2', 'p1', 'u1', 1, 'T', 1, '${now}', '${now}')`,
    );
  });

  await t.test("pattern numbers are unique within a project", async () => {
    await assert.rejects(
      db.execute(
        `INSERT INTO patterns (id, project_id, owner_id, number, name, version, created_at, updated_at)
         VALUES ('t3', 'p1', 'u1', 1, 'T', 1, '${now}', '${now}')`,
      ),
      /UNIQUE constraint failed: patterns\.project_id, patterns\.number/,
    );
  });

  await t.test("names, versions and stored results are checked", async () => {
    for (const [sql, expected] of [
      [`UPDATE projects SET name = '' WHERE id = 'p1'`, /CHECK constraint failed: length\(name\)/],
      [`UPDATE projects SET version = 0 WHERE id = 'p1'`, /CHECK constraint failed: version >= 1/],
      [
        `INSERT INTO requests (owner_id, request_id, operation, fingerprint, result, created_at)
         VALUES ('u1', 'r1', 'op', 'f', 'not json', '${now}')`,
        /CHECK constraint failed: json_valid\(result\)/,
      ],
      [
        `INSERT INTO projects (id, owner_id, name, version, next_pattern_number, created_at, updated_at)
         VALUES ('p2', 'missing-user', 'P', 1, 1, '${now}', '${now}')`,
        /FOREIGN KEY constraint failed/,
      ],
    ] as const) {
      await assert.rejects(db.execute(sql), expected, sql);
    }
  });
});

await test("Revision and snapshot constraints", async (t) => {
  const db = await migratedDatabase();
  t.after(() => db.remove());
  const now = "2026-11-14T00:00:00.000Z";
  const hash = "a".repeat(64);
  await db.execute(`
    INSERT INTO users VALUES
      ('u1', 'https://a.invalid', 's1', 'one@example.com', '${now}'),
      ('u2', 'https://a.invalid', 's2', 'two@example.com', '${now}');
    INSERT INTO projects VALUES
      ('p1', 'u1', 'P', 1, 3, '${now}', '${now}'),
      ('p2', 'u2', 'P', 1, 2, '${now}', '${now}');
    INSERT INTO patterns VALUES
      ('t1', 'p1', 'u1', 1, 'T', 1, '${now}', '${now}'),
      ('t2', 'p1', 'u1', 2, 'T', 1, '${now}', '${now}'),
      ('t3', 'p2', 'u2', 1, 'T', 1, '${now}', '${now}');
    INSERT INTO snapshots VALUES
      ('s1', 'u1', 1, 'one/manifest.json', '${hash}', '${now}'),
      ('s2', 'u2', 1, 'two/manifest.json', '${hash}', '${now}');
    INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('r1', 't1', 'u1', 1, 'R', 's1', NULL, '${now}');
  `);
  for (const [label, sql, expected] of [
    [
      "revision owner must equal pattern owner",
      `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('bad', 't1', 'u2', 2, 'R', 's2', NULL, '${now}')`,
      /FOREIGN KEY constraint failed/,
    ],
    [
      "revision owner must equal snapshot owner",
      `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('bad', 't1', 'u1', 2, 'R', 's2', NULL, '${now}')`,
      /FOREIGN KEY constraint failed/,
    ],
    [
      "base must belong to the same pattern",
      `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('bad', 't2', 'u1', 1, 'R', 's1', 'r1', '${now}')`,
      /FOREIGN KEY constraint failed/,
    ],
    [
      "history numbers cannot repeat",
      `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('bad', 't1', 'u1', 1, 'R', 's1', NULL, '${now}')`,
      /UNIQUE constraint failed: revisions.pattern_id, revisions.number/,
    ],
    [
      "number starts at one",
      `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('bad', 't1', 'u1', 0, 'R', 's1', NULL, '${now}')`,
      /CHECK constraint failed: number >= 1/,
    ],
    [
      "revision name cannot be empty",
      `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('bad', 't1', 'u1', 2, '', 's1', NULL, '${now}')`,
      /CHECK constraint failed: length\(name\)/,
    ],
    [
      "revision name cannot exceed 100 characters",
      `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('bad', 't1', 'u1', 2, '${"あ".repeat(101)}', 's1', NULL, '${now}')`,
      /CHECK constraint failed: length\(name\)/,
    ],
    [
      "snapshot owner must exist",
      `INSERT INTO snapshots VALUES ('bad', 'missing', 1, 'bad', '${hash}', '${now}')`,
      /FOREIGN KEY constraint failed/,
    ],
    [
      "only implemented manifest versions can be stored",
      `INSERT INTO snapshots VALUES ('bad', 'u1', 2, 'bad', '${hash}', '${now}')`,
      /CHECK constraint failed: format_version = 1/,
    ],
    [
      "hash must be lowercase hex",
      `INSERT INTO snapshots VALUES ('bad', 'u1', 1, 'bad', '${"z".repeat(64)}', '${now}')`,
      /CHECK constraint failed/,
    ],
    [
      "hash must have 64 digits",
      `INSERT INTO snapshots VALUES ('bad', 'u1', 1, 'bad', 'aa', '${now}')`,
      /CHECK constraint failed/,
    ],
  ] as const) {
    await t.test(label, () => assert.rejects(db.execute(sql), expected));
  }
  await db.execute(
    `INSERT INTO revisions (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at) VALUES ('r2', 't1', 'u1', 2, 'R2', 's1', 'r1', '${now}')`,
  );
});
