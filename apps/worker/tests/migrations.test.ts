import assert from "node:assert/strict";
import { test } from "node:test";
import { migratedDatabase } from "./support/local-worker.ts";

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
