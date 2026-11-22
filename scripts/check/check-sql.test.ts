import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";
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
  "const sql = `${a}INSERT${b} INTO requests (request_id, result) VALUES (?, '{}')`;",
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

for (const { name, files, subfolder, checked, missing } of [
  {
    name: "only migrations exist",
    files: { "apps/worker/migrations/0001_init.sql": "SELECT 1;" },
    subfolder: "",
    checked: 1,
    missing: ["apps/worker/src/**/*.ts"],
  },
  {
    name: "only Worker sources exist",
    files: { "apps/worker/src/index.ts": 'const sql = "SELECT 1";' },
    subfolder: "",
    checked: 1,
    missing: ["apps/worker/migrations/*.sql"],
  },
  {
    name: "the root is the Worker subfolder",
    files: cleanFiles,
    subfolder: "apps/worker",
    checked: 0,
    missing: ["apps/worker/src/**/*.ts", "apps/worker/migrations/*.sql"],
  },
]) {
  void test(`rejects missing target sets when ${name}`, async (t) => {
    const root = join(sqlTree(t, files), subfolder);
    assert.deepEqual(await checkSqlFiles(root), {
      files: checked,
      violations: missing.map((pattern) => `${pattern}: no files found under ${root}.`),
    });
  });
}

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
  assert.equal(
    result.stdout,
    "SQL connection-state, request-write and result-nesting checks passed: 2 files.\n",
  );
});

void test("SQL CLI fails when neither target set contains files", (t) => {
  const root = sqlTree(t, {});
  const result = spawnSync(process.execPath, [sqlScript, root], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.stderr,
    `apps/worker/src/**/*.ts: no files found under ${root}.\n` +
      `apps/worker/migrations/*.sql: no files found under ${root}.\n`,
  );
  assert.equal(result.stdout, "");
});

const rule =
  "build the whole object in one json_object expression and keep subqueries out of the select list and FROM (see recordStatement in apps/worker/src/storage/requests.ts).";
const subquery = `result SQL builds its value from a subquery; ${rule}`;
const cte = `result SQL uses a CTE; ${rule}`;
const helperPath = "apps/worker/src/storage/revisions.ts";
const nested =
  "(SELECT json_object('id', r.id) FROM revisions r WHERE r.pattern_id = ? ORDER BY r.number DESC LIMIT 1)";
function interpolates(owner: string) {
  return `result SQL interpolates ${owner}, which builds its value from a subquery or CTE; ${rule}`;
}
function diagnostic(source: string, needle: string, message: string, path = storagePath) {
  const position = source.lastIndexOf(needle);
  assert.ok(position >= 0, needle);
  const prefix = source.slice(0, position);
  return `${path}:${prefix.split("\n").length}:${position - prefix.lastIndexOf("\n")}: ${message}`;
}
function call(sql: string, callee = "createOnceStatements") {
  return `${callee}(db, key, { result: { sql: ${sql}, bindings } });`;
}
for (const callee of ["createOnceStatements", "updateOnceStatements"]) {
  for (const [sql, message] of [
    [
      "SELECT json_object('pattern', (SELECT json_object('id', t.id) FROM patterns t WHERE t.id = ?))",
      subquery,
    ],
    [`SELECT json_object('revision', ${nested})`, subquery],
    [
      "SELECT json_object('pattern', x.pattern) FROM (SELECT json_object('id', t.id) AS pattern FROM patterns t WHERE t.id = ?) x",
      subquery,
    ],
    [
      "WITH x AS (SELECT json_object('id', t.id) AS pattern FROM patterns t WHERE t.id = ?) SELECT json_object('pattern', x.pattern) FROM x",
      cte,
    ],
    ["SELECT a FROM jobs JOIN (SELECT id FROM revisions) r ON r.id = jobs.id", subquery],
    ["SELECT * FROM (VALUES (1))", subquery],
    ["SELECT id FROM jobs WHERE done UNION SELECT (SELECT 1)", subquery],
    ["select json_object( -- revision\n (select 1))", subquery],
  ] as const) {
    for (const literal of [JSON.stringify(sql), "`" + sql + "`"]) {
      void test(`${callee} rejects ${literal}`, () => {
        const source = call(literal, callee);
        assert.deepEqual(checkSqlSource(storagePath, source), [
          diagnostic(source, literal, message),
        ]);
      });
    }
  }
}

for (const sql of [
  "SELECT id FROM jobs WHERE EXISTS (SELECT 1) AND id IN (SELECT id FROM tasks) AND n = (SELECT max(n) FROM tasks)",
  "SELECT id FROM jobs JOIN revisions ON r.id = (SELECT max(id) FROM revisions)",
  "SELECT id FROM jobs ORDER BY (SELECT 1) LIMIT (SELECT 2)",
  "SELECT json_group_array(json_object('id', m.id) ORDER BY m.number) FROM m",
  "SELECT row_number() OVER (ORDER BY t.id) FROM t",
  "SELECT '(SELECT 1)' /* (SELECT 1) */ -- (SELECT 1)",
]) {
  void test(`allows ${sql}`, () =>
    assert.deepEqual(checkSqlSource(storagePath, call(JSON.stringify(sql))), []));
}

for (const [setup, sql, span, name] of [
  [
    `function latest() { return \`${nested}\`; }`,
    "SELECT json_object('r', ${latest()})",
    "latest()",
    "latest",
  ],
  [
    `const second = () => "${nested}"; function first() { return \`prefix \${second()}\`; }`,
    "SELECT json_object('r', ${first()})",
    "first()",
    "second",
  ],
  ["", "SELECT json_object('state', ${part({state: \"(SELECT 'cancelled')\"})})", "part({", ""],
  ["", "SELECT json_object('r', ${ready ? '(SELECT 1)' : 'NULL'})", "ready ?", ""],
  ...['let latest = "NULL"', "let latest: string"].map(
    (decl) =>
      [
        `${decl}; if (flag) latest = \`${nested}\`;`,
        "SELECT json_object('r', ${latest})",
        "latest",
        "latest",
      ] as const,
  ),
  [
    `function latestRevision(j) { return {sql: "${nested}"} } const {sql: latestSql} = latestRevision("j");`,
    "SELECT json_object('r', ${latestSql})",
    "latestSql",
    "latestRevision",
  ],
  [
    `function latest(j:string):string; function latest(j:string){return "${nested}"}`,
    "SELECT json_object('r', ${latest(j)})",
    "latest(j)",
    "latest",
  ],
  [
    "const revisionJoin = j => `LEFT JOIN (SELECT r.job_id, ${revisionJson('r')} AS doc FROM revisions r ORDER BY r.number DESC LIMIT 1) cr ON cr.job_id = ${j}.id`;",
    "SELECT j.id FROM j JOIN t ON t.id = j.id ${revisionJoin('j')}",
    "revisionJoin('j')",
    "revisionJoin",
  ],
  [
    "let pieces = []; pieces += '(SELECT 1)';",
    "SELECT json_object('r', ${pieces.join(',')})",
    "pieces.join",
    "pieces",
  ],
  ["", "SELECT json_object('r', ${xs.map(() => '(SELECT 1)').join(',')})", "xs.map", ""],
] as const) {
  void test(`follows ${span} in ${setup}`, () => {
    const source = setup + "\n" + call("`" + sql + "`");
    assert.deepEqual(checkSqlSource(storagePath, source), [
      diagnostic(source, span, interpolates(name ? `${name} in ${storagePath}` : "an expression")),
    ]);
  });
}

const revisionModule =
  "export const revisionJson = p => `(SELECT json_object('id', r.id) FROM revisions r WHERE r.pattern_id = ${p}.id ORDER BY r.number DESC LIMIT 1)`;";
function importedSource(specifier: string) {
  return (
    `import { revisionJson as doc } from "${specifier}";\n` +
    call("`SELECT json_object('r', ${doc('j')})`")
  );
}
for (const [specifier, path] of [
  ["./revisions.ts", helperPath],
  ["./revisions", helperPath],
  ["./revisions", helperPath.replace(".ts", "/index.ts")],
] as const) {
  void test(`resolves ${specifier} to ${path}`, () => {
    const source = importedSource(specifier);
    assert.deepEqual(checkSqlSource(storagePath, source, new Map([[path, revisionModule]])), [
      diagnostic(source, "doc('j')", interpolates(`revisionJson in ${path}`)),
    ]);
  });
}

const joinHelper = "const joined = 'JOIN revisions r ON r.id = (SELECT max(id) FROM revisions)';";
for (const [setup, sql] of [
  [
    "const owned = 'WHERE j.pattern_id IN (SELECT p.id FROM patterns p)';",
    "SELECT j.id FROM j ${owned}",
  ],
  [joinHelper, "SELECT j.id FROM j ${joined}"],
  [joinHelper, "SELECT j.id FROM j JOIN t ON j.id = t.id ${joined}"],
  [
    "const current = await db.first({sql: '(SELECT locked FROM jobs)'});",
    "SELECT json_object('id', id ${current.locked ? \", 'locked', 1\" : ''})",
  ],
  [
    "const part = '(SELECT 1)'; function wrap({part}) { return part }",
    "SELECT json_object('r', ${wrap({part:'NULL'})})",
  ],
  [
    "const states = ['held'].filter(x => x).map(x => x).join(', '); function roles() { if (!states) throw new Error('Call it with at least one role'); return states }",
    "SELECT json_object('s', ${roles()})",
  ],
  [
    "const notHeld = '(SELECT 1)'; const sub = 'SELECT 1';",
    "SELECT id FROM jobs WHERE (${notHeld}) AND x IN (${sub})",
  ],
  ["const a: string = b; const b: string = a;", "SELECT json_object('r', ${a})"],
  ["const sub = '(SELECT 1)';", "SELECT json_object('r', '${sub}')"],
  ["let part = 'NULL'; { let part; part = '(SELECT 1)' }", "SELECT json_object('r', ${part})"],
] as const) {
  void test(`allows ${sql} with ${setup}`, () => {
    assert.deepEqual(checkSqlSource(storagePath, setup + "\n" + call("`" + sql + "`")), []);
  });
}

for (const [args, needle] of [
  [", { result }", "result"],
  [", { result: build(id) }", "result:"],
  [", { result: {sql: a+b} }", "result:"],
  [", { result: {sql, bindings} }", "result:"],
  [", input", "input"],
  ["", "createOnceStatements"],
  [", { result: {sql:'SELECT 1'}, ...input }", "result:"],
  [", { result: {sql:'SELECT 1', ...part} }", "result:"],
] as const) {
  void test(`rejects unreadable result in (db, key${args})`, () => {
    const source = `createOnceStatements(db, key${args});`;
    assert.deepEqual(checkSqlSource(storagePath, source), [
      diagnostic(
        source,
        needle,
        "createOnceStatements needs result: { sql: `...` } written inline so check-sql can read its result SQL.",
      ),
    ]);
  });
}

for (const source of [
  "createOnceStatements(db,key, { result: { sql: 'SELECT (SELECT 1)' } as SqlPart });",
  "createOnceStatements(db,key, { ...common, result: { sql: 'SELECT (SELECT 1)' } });",
  'import {updateOnceStatements as update} from "./requests.ts";\n' +
    call("'SELECT (SELECT 1)'", "update"),
  call("'SELECT (SELECT 1)'", "requests.createOnceStatements"),
]) {
  void test(`locates the inline SQL in ${source}`, () => {
    assert.deepEqual(checkSqlSource(storagePath, source), [
      diagnostic(source, "'SELECT", subquery),
    ]);
  });
}
for (const source of [
  call("'SELECT (SELECT 1)'", "other"),
  "updateOnceStatements(db,key, ({result: {sql: 'SELECT 1'} satisfies SqlPart})!);",
]) {
  void test(`accepts ${source}`, () => assert.deepEqual(checkSqlSource(storagePath, source), []));
}

void test("detects a planted CTE at every Worker result template", () => {
  const root = fileURLToPath(repositoryRoot);
  const modules = new Map(
    globSync("apps/worker/src/**/*.ts", { cwd: root }).map((path) => [
      path,
      readFileSync(join(root, path), "utf8"),
    ]),
  );
  let sites = 0;
  for (const [path, source] of modules) {
    assert.deepEqual(checkSqlSource(path, source, modules), []);
    for (const match of source.matchAll(/\bresult: \{\s*sql: `/g)) {
      const end = match.index + match[0].length;
      const planted = source.slice(0, end) + "WITH nested AS (SELECT 1) " + source.slice(end);
      assert.deepEqual(checkSqlSource(path, planted, modules), [
        diagnostic(planted, "`WITH nested AS", cte, path),
      ]);
      sites++;
    }
  }
  assert.ok(sites > 0);
});

void test("checkSqlFiles resolves SQL helpers across the target files", async (t) => {
  const source = importedSource("./revisions");
  const root = sqlTree(t, { ...cleanFiles, [storagePath]: source, [helperPath]: revisionModule });
  assert.deepEqual(await checkSqlFiles(root), {
    files: 4,
    violations: [diagnostic(source, "doc('j')", interpolates(`revisionJson in ${helperPath}`))],
  });
});

for (const span of [
  "('' + bad)",
  "(maybe ?? bad)",
  "(maybe || bad)",
  "(maybe && bad)",
  "(unused, bad)",
  "[...items, bad].join(',')",
  "({...parts, bad}).bad",
  "[bad][0]",
  "(await bad as string)!",
]) {
  void test(`follows SQL values through ${span}`, () => {
    const source =
      "const bad = '(SELECT 1)';\n" + call("`SELECT json_object('v', ${" + span + "})`");
    assert.deepEqual(checkSqlSource(storagePath, source), [
      diagnostic(source, span, interpolates(`bad in ${storagePath}`)),
    ]);
  });
}

for (const span of ["(bad, 'NULL')", "(bad === other)", "parts[bad]", "safe()"]) {
  void test(`ignores literals that do not contribute to ${span}`, () => {
    const source =
      "const bad = '(SELECT 1)'; function safe() {function unused() { return bad } return 'NULL'}\n" +
      call("`SELECT json_object('v', ${" + span + "})`");
    assert.deepEqual(checkSqlSource(storagePath, source), []);
  });
}

void test("reports the canonical name of an aliased call with an unreadable result", () => {
  const source =
    'import {updateOnceStatements as update} from "./requests.ts";\nupdate(db, key, input)';
  assert.deepEqual(checkSqlSource(storagePath, source), [
    diagnostic(
      source,
      "input",
      "updateOnceStatements needs result: { sql: `...` } written inline so check-sql can read its result SQL.",
    ),
  ]);
});
