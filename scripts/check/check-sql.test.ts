import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSqlSource } from "./check-sql.ts";

for (const source of [
  'const sql = "SELECT changes()";',
  "const sql = 'SELECT CHANGES ( )';",
  "const sql = `SELECT\nchanges()`;",
  "const sql = `SELECT changes() ${column}`;",
  "const sql = `SELECT ${column} changes() ${other}`;",
  "const sql = `SELECT ${column} changes()`;",
  'const sql = `SELECT ${fn({ value: "changes()" })}`;',
  "const sql = `SELECT ${`nested changes()`}`;",
]) {
  void test(`rejects a TypeScript SQL literal: ${source}`, () => {
    assert.equal(checkSqlSource("worker.ts", source).length, 1);
  });
}

void test("reports every violation with its source file, line and column", () => {
  const violations = checkSqlSource("worker.ts", "const sql = `SELECT\nchanges(), changes()`;");
  assert.equal(violations.length, 2);
  assert.match(violations[0] ?? "", /^worker\.ts:2:1: changes\(\)/);
  assert.match(violations[1] ?? "", /^worker\.ts:2:12: changes\(\)/);
});

void test("rejects migration SQL with its source location", () => {
  assert.match(
    checkSqlSource("migration.sql", "SELECT 1;\nSELECT changes();")[0] ?? "",
    /^migration\.sql:2:8:/,
  );
});

for (const source of [
  '// changes()\nconst sql = "SELECT 1";',
  "/* changes() */ const sql = `SELECT 1`;",
  "const sql = `SELECT ${column /* changes() */} 1`;",
  "const sql = `SELECT ${/changes()/.test(value)} 1`;",
  "const sql = `SELECT ${fn({ value: 1 }) /* changes() */} 1`;",
  'const sql = "SELECT exchanges(), changes_count";',
]) {
  void test(`allows comments and unrelated tokens: ${source}`, () => {
    assert.deepEqual(checkSqlSource("worker.ts", source), []);
  });
}
