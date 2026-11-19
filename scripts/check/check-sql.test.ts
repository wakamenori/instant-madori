import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSqlFiles, checkSqlSource } from "./check-sql.ts";

for (const name of ["changes", "total_changes", "last_insert_rowid"]) {
  for (const source of [
    `const sql = "SELECT ${name}()";`,
    `const sql = 'SELECT ${name.toUpperCase()} ( )';`,
    `const sql = \`SELECT\n${name}()\`;`,
    `const sql = \`SELECT ${name}() \${column}\`;`,
    `const sql = \`SELECT \${column} ${name}() \${other}\`;`,
    `const sql = \`SELECT \${column} ${name.toUpperCase()} \n()\`;`,
    `const sql = \`SELECT \${fn({ value: "${name}()" })}\`;`,
    `const sql = \`SELECT \${\`nested ${name}()\`}\`;`,
  ]) {
    void test(`rejects a TypeScript SQL literal: ${source}`, () => {
      const violations = checkSqlSource("worker.ts", source);
      assert.equal(violations.length, 1);
      assert.ok(violations[0]?.includes(`${name}() depends on connection state`));
    });
  }

  void test(`reports every ${name} violation with its source file, line and column`, () => {
    const violations = checkSqlSource("worker.ts", `const sql = \`SELECT\n${name}(), ${name}()\`;`);
    assert.deepEqual(violations, [
      `worker.ts:2:1: ${name}() depends on connection state; use row data instead.`,
      `worker.ts:2:${name.length + 5}: ${name}() depends on connection state; use row data instead.`,
    ]);
  });

  for (const call of [`${name}()`, `${name.toUpperCase()} ( )`, `${name} \n()`]) {
    void test(`rejects migration SQL with its source location: ${call}`, () => {
      assert.deepEqual(checkSqlSource("migration.sql", `SELECT 1;\nSELECT ${call};`), [
        `migration.sql:2:8: ${name}() depends on connection state; use row data instead.`,
      ]);
    });
  }

  for (const source of [
    `// ${name}()\nconst sql = "SELECT 1";`,
    `/* ${name}() */ const sql = \`SELECT 1\`;`,
    `const sql = \`SELECT \${column /* ${name}() */} 1\`;`,
    `const sql = \`SELECT \${/${name}()/.test(value)} 1\`;`,
    `const sql = \`SELECT \${fn({ value: 1 }) /* ${name}() */} 1\`;`,
    `const sql = "SELECT prefix_${name}(), ${name}_count";`,
  ]) {
    void test(`allows comments and unrelated tokens: ${source}`, () => {
      assert.deepEqual(checkSqlSource("worker.ts", source), []);
    });
  }
}

const storagePath = "apps/worker/src/storage/projects.ts";
const requestsPath = "apps/worker/src/storage/requests.ts";
const writeStatements = [
  "INSERT INTO $table (result) VALUES ('{}')",
  "insert into $table (result) values ('{}')",
  "INSERT\nINTO\n$table (result) VALUES ('{}')",
  "INSERT OR IGNORE INTO $table (result) VALUES ('{}')",
  "INSERT OR REPLACE INTO $table (result) VALUES ('{}')",
  "UPDATE $table SET result = '{}'",
  "UPDATE OR FAIL $table SET result = '{}'",
  "DELETE FROM $table WHERE request_id = ?",
  "REPLACE INTO $table (result) VALUES ('{}')",
  "INSERT INTO $table (result) VALUES ('{}') ON CONFLICT DO UPDATE SET result = '{}'",
  "WITH result AS (SELECT '{}') INSERT INTO $table SELECT * FROM result",
  "SELECT 1; DELETE FROM $table",
  "INSERT /* record */ INTO -- target\n$table (result) VALUES ('{}')",
];

for (const table of [
  "requests",
  "ReQuEsTs",
  '"requests"',
  "`requests`",
  "[requests]",
  "'requests'",
  '"main" . "REQUESTS"',
]) {
  for (const statement of writeStatements) {
    const sql = statement.replace("$table", table);
    const source = `const sql = ${JSON.stringify(sql)};`;
    void test(`restricts request writes to requests.ts: ${sql}`, () => {
      const violations = checkSqlSource(storagePath, source);
      assert.equal(violations.length, 1);
      assert.equal(
        violations[0],
        `${storagePath}:1:13: writes to requests are only allowed in ${requestsPath}.`,
      );
      assert.deepEqual(checkSqlSource(requestsPath, source), []);
    });
  }
}

for (const source of [
  "const sql = `INSERT\nINTO\nrequests (result) VALUES ('{}')`;",
  "const sql = `INSERT INTO requests (result) SELECT ${result}`;",
  "const sql = `SELECT ${column}; UPDATE requests SET result = ${result}`;",
  "const sql = `SELECT ${column}; DELETE FROM requests`;",
  'const sql = `SELECT ${fn({ value: "INSERT INTO requests DEFAULT VALUES" })}`;',
  "const sql = `SELECT ${`DELETE FROM requests`}`;",
  "const sql = `WITH v AS (SELECT '${plantedTable}' AS s) INSERT INTO requests (request_id, result) SELECT s, '{}' FROM v`;",
  "const sql = `UPDATE patterns SET name = '${plantedTable}' WHERE id = ?;\nINSERT INTO requests (request_id, result) VALUES (?, '{}')`;",
  'const sql = `SELECT "${column}" FROM patterns; DELETE FROM requests WHERE "request_id" = ?`;',
  "const sql = `CREATE TRIGGER record_request AFTER UPDATE ON patterns WHEN new.state = '${s}' BEGIN INSERT INTO requests (request_id, result) VALUES (?, '{}'); END`;",
  "const sql = `SELECT \\`${column}\\` FROM patterns; DELETE FROM requests WHERE \\`request_id\\` = ?`;",
  "const sql = `SELECT [${column}] FROM patterns; REPLACE INTO requests (result) VALUES ('{}')`;",
  "const sql = `INSERT INTO ${schema}.requests (result) VALUES ('{}')`;",
  "const sql = `INSERT ${conflict} INTO requests (request_id, result) VALUES (?, '{}')`;",
  "const sql = `UPDATE ${conflict} requests SET result = '{}' WHERE request_id = ?`;",
  "const sql = `${prefix}INSERT INTO requests (request_id, result) VALUES (?, '{}')`;",
  "const sql = `UPDATE ${schema}.requests SET result = '{}' WHERE request_id = ?`;",
  "const sql = `INSERT${x} INTO requests (request_id, result) VALUES (?, '{}')`;",
  'const sql = `INSERT${ignore ? " OR IGNORE" : ""} INTO requests (request_id, result) VALUES (?, \'{}\')`;',
  "const sql = `UPDATE${x} requests SET result = '{}' WHERE request_id = ?`;",
  "const sql = `DELETE${x} FROM requests WHERE request_id = ?`;",
  "const sql = `REPLACE${x} INTO requests (request_id, result) VALUES (?, '{}')`;",
]) {
  void test(`rejects request writes in templates and nested literals: ${source}`, () => {
    assert.equal(checkSqlSource(storagePath, source).length, 1);
    assert.deepEqual(checkSqlSource(requestsPath, source), []);
  });
}

void test("reports the whole template's location after a quoted interpolation", () => {
  const source =
    "const sql =\n  `SELECT '${name}';\n   INSERT INTO requests (result) VALUES ('{}')`;";
  assert.deepEqual(checkSqlSource(storagePath, source), [
    `${storagePath}:2:3: writes to requests are only allowed in ${requestsPath}.`,
  ]);
});

for (const source of [
  "const sql = `SELECT '${name}' FROM requests`;",
  "const sql = `SELECT '${name} INSERT INTO requests'`;",
  'const sql = `SELECT "${column} DELETE FROM requests" FROM patterns`;',
  "const sql = `SELECT 1 /* ${description} DELETE FROM requests */`;",
  "const sql = `INSERT INTO requests${suffix} (result) VALUES ('{}')`;",
  "const sql = `INSERT INTO ${a}requests (result) VALUES ('{}')`;",
  "const sql = `INSERT INTO ${table} (result) VALUES ('{}')`;",
]) {
  void test(`allows quoted values, comments and dynamically named tables: ${source}`, () => {
    assert.deepEqual(checkSqlSource(storagePath, source), []);
  });
}

for (const sql of [
  "SELECT result FROM requests",
  'SELECT result FROM "requests"',
  "UPDATE patterns SET name = ? WHERE EXISTS (SELECT 1 FROM requests)",
  "INSERT INTO requests_archive SELECT * FROM requests",
  'INSERT INTO "requests.archive" DEFAULT VALUES',
  "DELETE FROM requests_old",
  "DELETE FROM requests.archive",
  'UPDATE patterns SET "requests" = 1',
  "SELECT 'DELETE FROM requests'",
  'SELECT "INSERT INTO requests"',
  "SELECT 1 -- DELETE FROM requests",
  "SELECT 1 /* INSERT INTO requests */",
]) {
  void test(`allows reads, unrelated writes and SQL comments: ${sql}`, () => {
    assert.deepEqual(checkSqlSource(storagePath, `const sql = ${JSON.stringify(sql)};`), []);
  });
}

for (const source of [
  '// INSERT INTO requests\nconst sql = "SELECT 1";',
  '/* DELETE FROM requests */ const sql = "SELECT 1";',
  "const sql = `SELECT ${column /* UPDATE requests SET result = 1 */}`;",
  "const pattern = /INSERT INTO requests/;",
]) {
  void test(`ignores TypeScript comments and regular expressions: ${source}`, () => {
    assert.deepEqual(checkSqlSource(storagePath, source), []);
  });
}

void test("restricts request writes by the full normalized path", () => {
  const source = 'const sql = "INSERT INTO requests DEFAULT VALUES";';
  for (const path of [
    "apps/worker/src/requests.ts",
    "apps/worker/src/storage/other/requests.ts",
    "./apps/worker/src/storage/projects.ts",
    fileURLToPath(new URL("../../apps/worker/src/storage/projects.ts", import.meta.url)),
  ]) {
    assert.equal(checkSqlSource(path, source).length, 1, path);
  }
  for (const path of [
    "apps/worker/tests/requests.ts",
    "apps/web/src/requests.ts",
    "./apps/worker/src/storage/requests.ts",
    "apps/worker/src/storage/../storage/requests.ts",
    fileURLToPath(new URL("../../apps/worker/src/storage/requests.ts", import.meta.url)),
  ]) {
    assert.deepEqual(checkSqlSource(path, source), [], path);
  }
  assert.deepEqual(checkSqlSource("apps/worker/migrations/0001.sql", "DELETE FROM requests"), []);
});

void test("keeps the connection-state restriction inside requests.ts", () => {
  assert.deepEqual(checkSqlSource(requestsPath, 'const sql = "SELECT changes()";'), [
    `${requestsPath}:1:21: changes() depends on connection state; use row data instead.`,
  ]);
});

function sqlTree(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "madori-sql-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const violatingFiles = {
  "apps/worker/src/index.ts": 'const sql = "SELECT 1";',
  "apps/worker/src/storage/requests.ts": 'const sql = "INSERT INTO requests DEFAULT VALUES";',
  "apps/worker/src/storage/deep/nested.ts":
    'const sql = "SELECT changes()";\nconst write = "INSERT INTO requests DEFAULT VALUES";',
  "apps/worker/migrations/0001_init.sql": "SELECT last_insert_rowid();",
};
const expectedFileViolations = [
  "apps/worker/src/storage/deep/nested.ts:1:21: changes() depends on connection state; use row data instead.",
  "apps/worker/src/storage/deep/nested.ts:2:15: writes to requests are only allowed in apps/worker/src/storage/requests.ts.",
  "apps/worker/migrations/0001_init.sql:1:8: last_insert_rowid() depends on connection state; use row data instead.",
];
const cleanFiles = {
  "apps/worker/src/index.ts": 'const sql = "SELECT 1";',
  "apps/worker/migrations/0001_init.sql": "CREATE TABLE example (id TEXT);",
};

void test("discovers nested SQL files and reports sorted root-relative diagnostics", async (t) => {
  const root = sqlTree(t, violatingFiles);
  assert.deepEqual(await checkSqlFiles(root), {
    files: 4,
    violations: expectedFileViolations,
  });
});

const sqlScript = fileURLToPath(new URL("./check-sql.ts", import.meta.url));

void test("SQL CLI exits with failure and diagnostics for violating files", (t) => {
  const root = sqlTree(t, violatingFiles);
  const result = spawnSync(process.execPath, [sqlScript, root], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, expectedFileViolations.join("\n") + "\n");
  assert.equal(result.stdout, "");
});

void test("SQL CLI exits successfully and reports the clean file count", (t) => {
  const root = sqlTree(t, cleanFiles);
  const result = spawnSync(process.execPath, [sqlScript, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "SQL connection-state and request-write checks passed: 2 files.\n");
});
