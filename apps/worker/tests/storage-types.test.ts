import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

void test("Storage types reject unverified identities, duplicate owners and forged batches", () => {
  const configFile = fileURLToPath(new URL("./rpc/tsconfig.json", import.meta.url));
  const fixtureFile = fileURLToPath(new URL("./rpc/storage-type-fixture.ts", import.meta.url));
  const config = ts.readConfigFile(configFile, (path) => ts.sys.readFile(path));
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    fileURLToPath(new URL("./rpc/", import.meta.url)),
  );
  assert.deepEqual(parsed.errors, []);
  const prelude = `
    import { z } from "zod";
    import { d1, rows } from "../../src/storage/d1.ts";
    declare const database: ReturnType<typeof d1>;
    import type { Store } from "../../src/storage/store.ts";
    import type { OwnerId } from "../../src/owner.ts";
    import type { VerifiedIdentity } from "../../src/services/identity.ts";
    import type { RequestKey } from "../../src/storage/requests.ts";
    declare const store: Store;
    declare const ownerId: OwnerId;
    declare const patternId: string;
    declare const key: RequestKey;
  `;
  function diagnostics(source: string, file = fixtureFile) {
    const options = { ...parsed.options, noUnusedLocals: false, noUnusedParameters: false };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      path === file
        ? ts.createSourceFile(
            file,
            (prelude + source).replaceAll(
              "../../src/",
              file === fixtureFile ? "../../src/" : "../",
            ),
            options.target ?? ts.ScriptTarget.ESNext,
            true,
          )
        : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram(
      [...parsed.fileNames.filter((path) => path.endsWith("worker-configuration.d.ts")), file],
      options,
      host,
    );
    return ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === file);
  }
  assert.deepEqual(
    diagnostics(`
    void store.patterns.get({ ownerId, patternId });
    void store.projects.renameOnce(key, { projectId: patternId, expectedVersion: 1, name: "renamed", now: "now" });
  `),
    [],
  );
  const failures = diagnostics(`
    const id: OwnerId = patternId;
    const identity: VerifiedIdentity = { issuer: "issuer", subject: "subject", email: "email" };
    void store.patterns.get({ ownerId: patternId, patternId });
    void store.projects.renameOnce(key, { ownerId, projectId: patternId, expectedVersion: 1, name: "renamed", now: "now" });
    void store.jobs.check(ownerId);
    void store.db;
    void database.first<{ name: string }>({ sql: "SELECT 1", bindings: [] });
    void database.all(rows<z.ZodType<{ name: string }>>({ sql: "SELECT 1", bindings: [] }, z.unknown(), "row"));
  `);
  assert.deepEqual(
    failures.map((diagnostic) => [
      diagnostic.code,
      diagnostic.start === undefined
        ? -1
        : diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start).line,
    ]),
    [
      [2322, 13],
      [2739, 14],
      [2322, 15],
      [2353, 16],
      [2345, 17],
      [2339, 18],
      [2345, 19],
      [2379, 20],
    ],
  );
  const imports = `
    import { authenticatedUser } from "../../src/owner.ts";
    import { freezeIdentity, VerifiedIdentity as IdentityClass } from "../../src/identity.ts";
    import type { User } from "@madori/contracts";
    declare const user: User;
    declare const identity: VerifiedIdentity;
    declare const resolved: Awaited<ReturnType<Store["users"]["upsertAccess"]>>;
  `;
  const missingRights = diagnostics(`
    void store.jobs.check(ownerId);
    void store.jobs.check({ reference: { patternId, jobId: patternId, generation: 1 } });
  `);
  assert.equal(missingRights.length, 2);
  for (const diagnostic of missingRights) {
    assert.equal(diagnostic.code, 2345);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    assert.match(message, /JobExecutionRight/);
    assert.match(message, /#scope/);
  }
  assert.deepEqual(
    diagnostics(`
    import type { JobExecutionRight } from "../../src/storage/job-execution.ts";
    declare const right: JobExecutionRight;
    void store.jobs.check(right);
  `),
    [],
  );
  const valid = `
    import { verifyAccessToken } from "../../src/api/access.ts";
    import type { AccessConfig } from "../../src/api/config.ts";
    declare const request: Request;
    declare const access: AccessConfig;
    async function resolve() {
      const result = await store.users.upsertAccess({ identity, newId: patternId, now: "now" });
      const owner: OwnerId = authenticatedUser(identity, result).id;
      const verified = await verifyAccessToken(request, access);
      const verifiedResult = await store.users.upsertAccess({ identity: verified, newId: patternId, now: "now" });
      authenticatedUser(verified, verifiedResult);
      return owner;
    }
  `;
  const invalid = `
    authenticatedUser();
    authenticatedUser(user);
    authenticatedUser(user, resolved);
    authenticatedUser(identity, user);
    authenticatedUser(identity, { ...resolved });
    store.users.upsertAccess({ issuer: "issuer", subject: "subject", email: "email", newId: patternId, now: "now" });
    freezeIdentity({ issuer: "issuer", subject: "subject", email: "email" });
    identity.subject = "other";
    authenticatedUser({ ...identity, subject: "x" }, resolved);
    store.users.upsertAccess({ identity: { ...identity, subject: "x" }, newId: patternId, now: "now" });
    new IdentityClass(identity);
    import { ResolvedAccessUser as ResolvedClass } from "../../src/storage/users.ts";
    new ResolvedClass(identity, user);
  `;
  for (const path of [
    fixtureFile,
    fileURLToPath(new URL("../src/services/owner-type-fixture.ts", import.meta.url)),
  ]) {
    assert.deepEqual(diagnostics(imports + valid, path), []);
    assert.deepEqual(
      diagnostics(imports + invalid, path).map((diagnostic) => diagnostic.code),
      [2554, 2554, 2345, 2345, 2345, 2353, 2345, 2540, 2345, 2739, 2673, 1485, 2673, 1362],
    );
  }
  const batchImports = `
    import { createOnceStatements, updateOnceStatements, runOnce } from "../../src/storage/requests.ts";
    import type { OnceBatch } from "../../src/storage/requests.ts";
    import type { SqlPart } from "../../src/storage/d1.ts";
    declare const part: SqlPart;
  `;
  assert.deepEqual(
    diagnostics(
      batchImports +
        `
      const created: OnceBatch = createOnceStatements(key, "now", {
        statements: [part], table: "patterns", id: patternId, result: part,
      });
      const updated: OnceBatch = updateOnceStatements(key, "now", {
        table: "projects", set: part, where: part, result: part,
      });
      void runOnce(database, z.object({ name: z.string() }), created);
      void runOnce(database, z.object({ name: z.string() }), updated);
    `,
    ),
    [],
  );
  for (const [source, codes] of [
    ["const batch: OnceBatch = {};", [2739]],
    ["const batch: OnceBatch = { before: [], record: part, after: [] };", [2353]],
    [
      'import { OnceBatch as Batch } from "../../src/storage/requests.ts"; new Batch();',
      [1485, 2673, 1362],
    ],
    ['import { recordStatement } from "../../src/storage/requests.ts";', [2459]],
    ["void runOnce(database, key, z.unknown(), {});", [2554]],
  ] as const) {
    assert.deepEqual(
      diagnostics(batchImports + source).map((diagnostic) => diagnostic.code),
      codes,
      source,
    );
  }
  const runtimeSource =
    batchImports +
    `
    import assert from "node:assert/strict";
    const batch = createOnceStatements(key, "now", {
      statements: [], table: "projects", id: patternId,
      result: { sql: "SELECT '{}'", bindings: [] },
    });
    const read = () => ({ key, parts: { before: [], record: { sql: "SELECT '{}'", bindings: [] }, after: [] } });
    assert.throws(() => Object.assign(batch.constructor, { read }), TypeError);
    assert.throws(() => Object.defineProperty(batch.constructor, "read", { value: read }), TypeError);
    assert.equal(Reflect.set(batch.constructor, "read", read), false);
    assert.equal(Object.isFrozen(Object.getPrototypeOf(batch)), true);
    let calls = 0;
    const observed: typeof database = {
      async first() { calls++; throw new Error("Unexpected D1 read"); },
      async all() { calls++; throw new Error("Unexpected D1 read"); },
      async batch() { calls++; throw new Error("Unexpected D1 batch"); },
    };
    const forged = {} as unknown as OnceBatch;
    await assert.rejects(runOnce(observed, z.unknown(), forged), TypeError);
    assert.equal(calls, 0);
  `;
  assert.deepEqual(diagnostics(runtimeSource), []);
  const runtime = ts.transpileModule(prelude + runtimeSource, {
    compilerOptions: { ...parsed.options, noEmit: false },
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const key = { ownerId: "owner", requestId: "request", operation: "create", fingerprint: "input" }; const patternId = "id";\n' +
        runtime.outputText,
    ],
    { cwd: new URL("./rpc/", import.meta.url), stdio: "pipe" },
  );
});
