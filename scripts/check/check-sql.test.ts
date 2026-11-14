import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSqlSource } from "./check-sql.ts";

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
