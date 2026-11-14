import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

void test("Store and owner types reject unverified identities and duplicate owner arguments", () => {
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
    void store.revisions.commit({ ownerId });
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
      [2741, 14],
      [2322, 15],
      [2353, 16],
      [2353, 17],
      [2339, 18],
      [2345, 19],
      [2379, 20],
    ],
  );
  const imports = `
    import { authenticatedUser } from "../../src/owner.ts";
    import { freezeIdentity } from "../../src/identity.ts";
    import type { User } from "@madori/contracts";
    declare const user: User;
    declare const identity: VerifiedIdentity;
    declare const resolved: Awaited<ReturnType<Store["users"]["upsertAccess"]>>;
  `;
  const valid = `
    async function resolve() {
      const result = await store.users.upsertAccess({ identity, newId: patternId, now: "now" });
      const owner: OwnerId = authenticatedUser(identity, result).id;
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
  `;
  for (const path of [
    fixtureFile,
    fileURLToPath(new URL("../src/services/owner-type-fixture.ts", import.meta.url)),
  ]) {
    assert.deepEqual(diagnostics(imports + valid, path), []);
    assert.deepEqual(
      diagnostics(imports + invalid, path).map((diagnostic) => diagnostic.code),
      [2554, 2554, 2345, 2345, 2345, 2353, 2345, 2540],
    );
  }
});
