import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ESLint } from "eslint";
import { z } from "zod";
import { createImportBoundaryChecker } from "./check-imports.ts";
import { typescriptScopes } from "./boundaries.ts";
import {
  boundaryTestIgnores,
  checkWorkerLayers,
  typescriptBoundaries,
  workerLayers,
} from "./boundaries.ts";

const boundaryRules = new Set([
  "no-restricted-syntax",
  "no-restricted-properties",
  "@typescript-eslint/no-import-type-side-effects",
  "no-restricted-globals",
  "@typescript-eslint/no-restricted-types",
]);
const eslint = new ESLint({
  ruleFilter: ({ ruleId }) => boundaryRules.has(ruleId),
  overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: false } } },
});
const scopes = {
  web: "apps/web/src/api.ts",
  "web-viewer-tests": "apps/web/src/viewer/viewport-session.test.ts",
  "web-wasm": "apps/web/src/viewer/wasm.ts",
  "web-config": "apps/web/vite.config.ts",
  "worker-api": "apps/worker/src/api/projects.ts",
  "worker-services": "apps/worker/src/services/projects.ts",
  "worker-storage": "apps/worker/src/storage/projects.ts",
  "worker-geometry": "apps/worker/src/geometry/geometry-client.ts",
  "worker-objects": "apps/worker/src/objects/pattern.ts",
  "worker-workflows": "apps/worker/src/workflows/steps.ts",
  "worker-objects-entry": "apps/worker/src/objects/pattern-coordinator.ts",
  "worker-workflows-entry": "apps/worker/src/workflows/job-workflow.ts",
  "worker-api-entry": "apps/worker/src/api/app.ts",
  "worker-access": "apps/worker/src/api/access.ts",
  "worker-d1": "apps/worker/src/storage/d1.ts",
  "worker-r2": "apps/worker/src/storage/r2.ts",
  "worker-composition": "apps/worker/src/compose.ts",
  "worker-owner": "apps/worker/src/owner.ts",
  "worker-other": "apps/worker/src/index.ts",
  contracts: "packages/contracts/src/index.ts",
} satisfies Record<keyof typeof typescriptScopes, string>;
const importType = (specifier: string, name = "Domain") =>
  `import type { ${name} } from ${JSON.stringify(specifier)};`;
const importValue = (specifier: string) => `import { value } from ${JSON.stringify(specifier)};`;
const root = mkdtempSync(join(tmpdir(), "madori-import-boundaries-"));
after(() => rmSync(root, { recursive: true, force: true }));
function write(path: string, text = "export const value = 1; export type Domain = string;") {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
}
const options = {
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  types: [],
  paths: { "@storage/*": ["./src/storage/*"], "@api/*": ["./src/api/*"] },
};
write(
  "package.json",
  JSON.stringify({ name: "fixture", type: "module", devDependencies: { typescript: "*" } }),
);
for (const [path, name] of [
  ["apps/web", "web"],
  ["apps/worker", "worker"],
  ["packages/contracts", "contracts"],
]) {
  write(
    `${path}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: options,
      include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    }),
  );
  write(
    `${path}/package.json`,
    JSON.stringify({
      name: `@madori/${name}`,
      type: "module",
      imports: { "#api": "./src/api/x.ts", "#storage": "./src/storage/x.ts" },
      exports: {
        ".": "./src/index.ts",
        "./*": "./src/*.ts",
        ...(name === "worker"
          ? { "./conditional": { import: "./src/api/x.ts", require: "./src/storage/x.ts" } }
          : {}),
        ...(name === "contracts"
          ? { "./geometry-internal": "./src/generated/geometry-internal.ts" }
          : {}),
      },
      dependencies: { "@madori/contracts": "workspace:*", zod: "*", "declared-external": "*" },
    }),
  );
}
write(
  "scripts/tsconfig.json",
  JSON.stringify({
    compilerOptions: { ...options, module: "NodeNext", moduleResolution: "NodeNext" },
    include: ["**/*.ts"],
  }),
);
mkdirSync(join(root, "node_modules/@madori"), { recursive: true });
for (const [name, path] of [
  ["contracts", "packages/contracts"],
  ["web", "apps/web"],
  ["worker", "apps/worker"],
]) {
  assert(path);
  symlinkSync(join(root, path), join(root, `node_modules/@madori/${name}`), "dir");
}
for (const path of Object.values(scopes)) write(path);
for (const layer of Object.keys(workerLayers)) {
  for (const path of [`apps/worker/src/${layer}/x.ts`, `apps/worker/src/${layer}/nested/x.ts`])
    write(path);
}
for (const path of [
  "apps/web/src/index.ts",
  "apps/web/src/worker/pool.ts",
  "apps/web/src/style.css",
  "apps/worker/src/geometry/types.d.ts",
  "apps/worker/src/log.ts",
  "apps/worker/src/geometry/geometry-protocol.ts",
  "apps/worker/src/storage/store.ts",
  "packages/contracts/src/generated/geometry-internal.ts",
  "packages/contracts/src/generated/geometry-bodies.ts",
  "packages/contracts/src/generated/display.ts",
  "scripts/shared/repository.ts",
  "scripts/dev/local-access.ts",
  "scripts/check/check.ts",
  "crates/viewer/pkg/madori_viewer.d.ts",
])
  write(path);
write(
  "apps/worker/worker-configuration.d.ts",
  'declare module "cloudflare:workers" { export class WorkerEntrypoint {} }',
);
write("packages/contracts/src/generated/geometry-internal.schema.json", "{}");
const checkFile = createImportBoundaryChecker(root);
function resolved(source: string, path = scopes["worker-api"]) {
  write(path, source);
  return checkFile(path);
}
function specifier(from: string, target: string) {
  const path = relative(dirname(join(root, from)), join(root, target)).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}
async function diagnostics(source: string, filePath: string) {
  const results = await eslint.lintText(source, { filePath });
  const messages = results.flatMap((result) => result.messages);
  assert(!messages.some((message) => message.fatal), JSON.stringify(messages));
  return messages.filter((message) => message.ruleId && boundaryRules.has(message.ruleId));
}
type BoundaryCases = { rejected: string[]; allowed: string[] };
const storageNetworkGlobals = [
  'void fetch("https://example.test");',
  "new Headers();",
  "type X = Headers;",
  "type X = typeof fetch;",
  "type X = typeof Headers;",
  ...["globalThis", "self"].flatMap((object) => [
    `void ${object}.fetch("https://example.test");`,
    `new ${object}.Headers();`,
    `const { fetch: request } = ${object};`,
    `const { Headers: HeaderMap } = ${object};`,
    `type X = typeof ${object}.fetch;`,
    `type X = typeof ${object}.Headers;`,
    `type X = ${object}.Headers;`,
  ]),
];

const syntaxCases: Record<string, BoundaryCases> = {
  "storage-binding-types": {
    rejected: [
      "type X = D1Database;",
      "type X = R2Bucket;",
      "type X = globalThis.D1Database;",
      "type X = typeof self.R2Bucket;",
      "type X = D1PreparedStatement;",
      "type X = R2ObjectBody;",
    ],
    allowed: ["type X = string;"],
  },
  "storage-binding-access": {
    rejected: [
      "env.DB;",
      'env["BLOBS"];',
      "const { DB: database } = env;",
      'const { ["BLOBS"]: bucket } = this.env;',
      'type X = Env["DB"];',
      'type X = Pick<Env, "BLOBS">;',
      "this.env.DB;",
      'import { env as bindings } from "cloudflare:workers";',
      'import * as cloudflare from "cloudflare:workers";',
      'void import("cloudflare:workers");',
      'export { env as bindings } from "cloudflare:workers";',
      'export * from "cloudflare:workers";',
    ],
    allowed: ["env.ASSETS;", 'type X = Env["GEOMETRY"];'],
  },
  "owner-assertions": {
    rejected: [
      "const id = value as OwnerId;",
      "const id = value as ids.OwnerId;",
      "const id = <OwnerId>value;",
    ],
    allowed: ["const id: OwnerId = user.id;"],
  },
  "identity-assertions": {
    rejected: [
      "const identity = value as VerifiedIdentity;",
      "const identity = value as ids.VerifiedIdentity;",
    ],
    allowed: ["const identity: VerifiedIdentity = verified;"],
  },
  "job-execution-assertions": {
    rejected: [
      "const right = value as JobExecutionRight;",
      "const right = value as unknown as JobExecutionRight;",
      "const right = value as jobs.JobExecutionRight;",
      "const right = <JobExecutionRight>value;",
    ],
    allowed: ["const right: JobExecutionRight = claimed.right;"],
  },
  "never-assertions": {
    rejected: ["const id: OwnerId = value as never;", "const id: OwnerId = <never>value;"],
    allowed: ["const unreachable: never = value;", "const checked = value satisfies never;"],
  },
  "storage-unchecked-schemas": {
    rejected: [
      "const row = z.custom<{ name: string }>();",
      "const row = z.any();",
      'import { custom } from "zod";',
    ],
    allowed: ["const row = z.object({ json: z.unknown() });"],
  },
  "services-http": {
    rejected: [
      'new Request("https://example.test");',
      "Response.json({});",
      "globalThis.Response.json({});",
      "type Input = Request;",
      "type Output = globalThis.Response;",
    ],
    allowed: [
      importType("@madori/contracts", "Project"),
      "const Response = { value: 1 }; void Response.value;",
      ...storageNetworkGlobals,
    ],
  },
  "storage-http": {
    rejected: [
      ...storageNetworkGlobals,
      'new Request("https://example.test");',
      "Response.json({});",
      "new globalThis.Request('https://example.test');",
      "type Input = Request;",
      "type Output = globalThis.Response;",
    ],
    allowed: [
      importType("@madori/contracts", "Project"),
      "const Request = { value: 1 }; void Request.value;",
    ],
  },
};

const workerLayerPermissions: Record<
  keyof typeof workerLayers,
  { allowed: string[]; typeOnly: string[] }
> = {
  api: { allowed: ["services"], typeOnly: ["geometry"] },
  services: { allowed: ["geometry"], typeOnly: ["storage"] },
  storage: { allowed: [], typeOnly: [] },
  geometry: { allowed: [], typeOnly: [] },
  workflows: { allowed: ["services"], typeOnly: [] },
  objects: { allowed: ["services"], typeOnly: [] },
};
const importCases: Record<string, string[]> = {
  "production-test-imports": ["apps/worker/tests/helper.ts", "apps/worker/src/example.test.ts"],
  "worker-composition-entry": ["apps/worker/src/compose.ts"],
  "worker-store-construction": [
    "apps/worker/src/storage/store.ts",
    "apps/worker/src/storage/d1.ts",
    "apps/worker/src/storage/r2.ts",
  ],
  "storage-response": ["packages/contracts/src/index.ts"],
  "web-worker": ["apps/worker/src/api/app.ts"],
  "web-scripts": ["scripts/dev/local-access.ts", "scripts/shared/repository.ts"],
  "web-config-scripts": ["scripts/check/check.ts", "scripts/shared/repository.ts"],
  "worker-web": ["apps/web/src/api.ts"],
  "contracts-apps": ["apps/web/src/api.ts", "apps/worker/src/api/app.ts"],
  "web-internal-geometry": [
    "packages/contracts/src/index.ts",
    "packages/contracts/src/generated/geometry-internal.ts",
    "packages/contracts/src/generated/geometry-bodies.ts",
    "packages/contracts/src/generated/geometry-internal.schema.json",
  ],
  "web-viewer-bindings": ["crates/viewer/pkg/madori_viewer.d.ts"],
};
for (const [layer, { allowed, typeOnly }] of Object.entries(workerLayerPermissions)) {
  importCases[`worker-${layer}-layers`] = Object.keys(workerLayerPermissions)
    .filter((target) => target !== layer && !allowed.includes(target) && !typeOnly.includes(target))
    .flatMap((target) => [
      `apps/worker/src/${target}/x.ts`,
      `apps/worker/src/${target}/nested/x.ts`,
    ]);
  if (typeOnly.length)
    importCases[`worker-${layer}-type-only`] = typeOnly.map(
      (target) => `apps/worker/src/${target}/x.ts`,
    );
}

void test("every boundary row has explicit rejected and allowed cases", () => {
  assert.deepEqual(
    [...Object.keys(importCases), ...Object.keys(syntaxCases)].sort(),
    typescriptBoundaries.map((row) => row.id).sort(),
  );
});
for (const row of typescriptBoundaries) {
  void test(`boundary ${row.id} rejects violations and allows dependencies`, async () => {
    for (const scope of row.from) {
      const from = scopes[scope];
      if (row.kind === "imports") {
        const targets = importCases[row.id];
        assert(targets?.length, row.id);
        for (const target of targets) {
          if (row.id === "production-test-imports") write(target);
          const name = specifier(from, target);
          const sources: string[] = [
            row.id === "storage-response" ? importType(name, "ProjectResponse") : importValue(name),
            `void import(${JSON.stringify(name)});`,
            `export * from ${JSON.stringify(name)};`,
            ...(!row.allowTypeImports
              ? [
                  `type X = import(${JSON.stringify(name)}).ProjectResponse;`,
                  `export type { ProjectResponse } from ${JSON.stringify(name)};`,
                ]
              : []),
          ];
          for (const source of sources) {
            assert(
              resolved(source, from).some((diagnostic) => diagnostic.boundaryId === row.id),
              `${row.id} ${from}: ${source}`,
            );
          }
          const testFile = from.replace(/\.ts$/u, ".test.ts");
          const testSource: string =
            row.id === "storage-response"
              ? importType(specifier(testFile, target), "ProjectResponse")
              : importValue(specifier(testFile, target));
          assert.equal(
            resolved(testSource, testFile).some((diagnostic) => diagnostic.boundaryId === row.id),
            row.appliesToTests === true,
            `${row.id} tests`,
          );
        }
        const safe = `${dirname(from)}/safe.ts`;
        write(safe);
        const allowed =
          row.id === "web-internal-geometry"
            ? importValue("@madori/contracts")
            : importValue(specifier(from, safe));
        assert.deepEqual(resolved(allowed, from), [], `${row.id} ${from}`);
      } else {
        const cases = syntaxCases[row.id];
        assert(cases?.rejected.length && cases.allowed.length, row.id);
        for (const source of cases.rejected)
          assert(
            (await diagnostics(source, from)).some((diagnostic) =>
              diagnostic.message.includes(row.message),
            ),
            `${row.id} ${from}: ${source}`,
          );
        for (const source of cases.allowed)
          assert.deepEqual(await diagnostics(source, from), [], `${row.id} ${from}: ${source}`);
      }
    }
  });
}

void test("Worker layers permit precisely their runtime and type dependencies", () => {
  for (const [layer, { allowed, typeOnly }] of Object.entries(workerLayerPermissions)) {
    const from = `apps/worker/src/${layer}/nested/source.ts`;
    for (const target of Object.keys(workerLayers)) {
      const name = specifier(from, `apps/worker/src/${target}/x.ts`);
      assert.equal(
        resolved(importValue(name), from).length === 0,
        target === layer || allowed.includes(target),
        `${layer} -> ${target}`,
      );
      assert.equal(
        resolved(importType(name), from).length === 0,
        target === layer || allowed.includes(target) || typeOnly.includes(target),
        `${layer} -> type ${target}`,
      );
    }
  }
});

void test("separators, redundant segments, case and package exports identify the same file", () => {
  const from = scopes["worker-storage"];
  const canonical = resolved(importValue("../api/projects.ts"), from).map(
    (diagnostic) => diagnostic.boundaryId,
  );
  assert(canonical.includes("worker-storage-layers"));
  for (const name of [
    "..//api/projects.ts",
    "..\\api\\projects.ts",
    "./../api/./projects.ts",
    "../services/../api/projects.ts",
    "@madori/worker/api/projects",
    "@api/projects.ts",
  ]) {
    assert.deepEqual(
      resolved(importValue(name), from).map((diagnostic) => diagnostic.boundaryId),
      canonical,
      name,
    );
  }
  const alternate = "apps/worker/src/API/projects.ts";
  try {
    const same =
      realpathSync.native(join(root, alternate)) ===
      realpathSync.native(join(root, "apps/worker/src/api/projects.ts"));
    assert(same);
    assert.deepEqual(
      resolved(importValue("../API/projects.ts"), from).map((diagnostic) => diagnostic.boundaryId),
      canonical,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    assert(
      resolved(importValue("../API/projects.ts"), from).some(
        (diagnostic) => diagnostic.boundaryId === "unresolved-import",
      ),
    );
  }
});

void test("unrelated worker, compose, owner and store files are allowed", () => {
  for (const [from, targets] of [
    [scopes.web, ["apps/web/src/worker/pool.ts", "apps/web/src/worker/index.ts"]],
    [
      scopes["worker-api"],
      [
        "apps/worker/src/api/helpers/compose.ts",
        "apps/worker/src/api/helpers/owner.ts",
        "apps/worker/src/api/helpers/storage/store.ts",
        "apps/worker/src/compose.helpers.ts",
      ],
    ],
  ] satisfies [string, string[]][]) {
    for (const target of targets) {
      write(target);
      assert.deepEqual(resolved(importValue(specifier(from, target)), from), [], target);
    }
  }
});

void test("parenthesized dynamic imports and Vite queries cannot hide forbidden targets", () => {
  assert(
    resolved('void import((("../storage/x.ts"))));').some(
      (diagnostic) => diagnostic.boundaryId === "worker-api-layers",
    ),
  );
  assert.deepEqual(resolved('void import((("../services/x.ts"))));'), []);
  for (const suffix of ["?raw", "?url", "#fragment", "?raw#fragment"]) {
    assert(
      resolved(`void import("../storage/x.ts${suffix}");`).some(
        (diagnostic) => diagnostic.boundaryId === "worker-api-layers",
      ),
    );
    assert.deepEqual(resolved(`void import("./worker/pool.ts${suffix}");`, scopes.web), []);
  }
  assert.deepEqual(resolved('void import("./worker/pool.ts?worker");', scopes.web), []);
  assert(
    resolved('void import("../worker/src/api/app.ts?raw");', scopes["web-config"]).some(
      (diagnostic) => diagnostic.boundaryId === "web-worker",
    ),
  );
});

void test("type references, module augmentations and ambient re-exports obey boundaries", () => {
  for (const [source, from, id] of [
    [
      '/// <reference types="../../../apps/worker/worker-configuration.d.ts" />',
      scopes.contracts,
      "contracts-apps",
    ],
    [
      '/// <reference path="../../../apps/worker/worker-configuration.d.ts" />',
      scopes.contracts,
      "contracts-apps",
    ],
    ['export {}; declare module "../storage/x.ts" {}', scopes["worker-api"], "worker-api-layers"],
    ['export {}; declare module "@storage/x.ts" {}', scopes["worker-api"], "worker-api-layers"],
    [
      'declare module "ambient-library" { export { value } from "../storage/x.ts"; }',
      scopes["worker-api"],
      "worker-api-layers",
    ],
    ['import x = require("../storage/x.ts");', scopes["worker-api"], "worker-api-layers"],
    ['import type x = require("../storage/x.ts");', scopes["worker-api"], "worker-api-layers"],
  ]) {
    assert(source && from && id);
    assert(
      resolved(source, from).some((diagnostic) => diagnostic.boundaryId === id),
      source,
    );
  }
  for (const source of [
    '/// <reference types="../geometry/types.d.ts" />',
    'export {}; declare module "../geometry/x.ts" {}',
    'export {}; declare module "@api/x.ts" {}',
    'declare module "ambient-library" { export { value } from "../services/x.ts"; }',
    'import x = require("../services/x.ts");',
    'import type x = require("../geometry/x.ts");',
  ])
    assert.deepEqual(resolved(source), [], source);
});

void test("contracts public entry keeps its declared package spelling", () => {
  for (const from of [
    scopes.web,
    scopes["web-config"],
    scopes["web-wasm"],
    scopes["web-viewer-tests"],
  ]) {
    assert.deepEqual(resolved(importValue("@madori/contracts"), from), []);
    for (const name of [
      specifier(from, "packages/contracts/src/index.ts"),
      "@madori/contracts/geometry-internal",
    ])
      assert(
        resolved(importValue(name), from).some(
          (diagnostic) => diagnostic.boundaryId === "web-internal-geometry",
        ),
        name,
      );
  }
});

void test("namespace, aliases and import qualifiers enforce response name restrictions", () => {
  for (const source of [
    'import type { ProjectResponse as Alias } from "@madori/contracts";',
    'export type { ApiError as Alias } from "@madori/contracts";',
    'import * as contracts from "@madori/contracts";',
    'type X = import("@madori/contracts").ProjectResponse.foo;',
    'type X = typeof import("@madori/contracts");',
    'import x = require("@madori/contracts");',
  ])
    assert(
      resolved(source, scopes["worker-storage"]).some(
        (diagnostic) => diagnostic.boundaryId === "storage-response",
      ),
      source,
    );
  assert.deepEqual(
    resolved(
      'import type { Project, Pattern } from "@madori/contracts";',
      scopes["worker-storage"],
    ),
    [],
  );
});

void test("type-only declarations and import types do not emit a runtime dependency", async () => {
  for (const source of [
    'import type { Domain } from "../geometry/x.ts";',
    'export type { Domain } from "../geometry/x.ts";',
    'type X = import("../geometry/x.ts").Domain;',
    'type X = typeof import("../geometry/x.ts");',
    'import type x = require("../geometry/x.ts");',
  ])
    assert.deepEqual(resolved(source), [], source);
  for (const source of [
    'import { type Domain } from "../geometry/x.ts";',
    'import { type Domain, value } from "../geometry/x.ts";',
    'export { type Domain } from "../geometry/x.ts";',
    'import "../geometry/x.ts";',
  ])
    assert(
      resolved(source).some((diagnostic) => diagnostic.boundaryId === "worker-api-type-only"),
      source,
    );
  assert(
    (await diagnostics('import { type Domain } from "../geometry/x.ts";', scopes["worker-api"]))
      .length > 0,
  );
});

void test("unresolvable imports fail, including tests, but builtins and declared packages are exempt", () => {
  for (const from of [scopes.web, scopes["worker-api"], "apps/worker/tests/example.ts"]) {
    for (const name of [
      "./missing.ts",
      "undeclared-package",
      "@madori/contracts/missing",
      "./missing.css",
      "node:fake-builtin",
    ])
      assert(
        resolved(importValue(name), from).some(
          (diagnostic) => diagnostic.boundaryId === "unresolved-import",
        ),
        `${from}: ${name}`,
      );
    for (const name of ["node:fs", "fs/promises", "declared-external/subpath"])
      assert.deepEqual(resolved(importValue(name), from), [], name);
  }
  assert.deepEqual(resolved('import "./style.css";', scopes.web), []);
  assert.deepEqual(resolved('import { WorkerEntrypoint } from "cloudflare:workers";'), []);
  assert(
    resolved('import "cloudflare:workers";', scopes.web).some(
      (diagnostic) => diagnostic.boundaryId === "unresolved-import",
    ),
  );
  assert(
    resolved('import "typescript";', scopes.web).some(
      (diagnostic) => diagnostic.boundaryId === "unresolved-import",
    ),
  );
});

void test("tests preserve viewer and cross-layer exceptions", () => {
  const target = "crates/viewer/pkg/madori_viewer.d.ts";
  for (const from of [scopes["web-wasm"], scopes["web-viewer-tests"]])
    assert.deepEqual(resolved(importValue(specifier(from, target)), from), []);
  for (const from of [
    "apps/web/src/api.test.ts",
    "apps/web/tests/example.ts",
    "apps/web/src/viewer/nested/example.test.ts",
    "apps/web/src/viewer/example.test.tsx",
  ])
    assert(
      resolved(importValue(specifier(from, target)), from).some(
        (diagnostic) => diagnostic.boundaryId === "web-viewer-bindings",
      ),
    );
  assert.deepEqual(
    resolved('import { value } from "../src/api/x.ts";', "apps/worker/tests/example.ts"),
    [],
  );
});

void test("every TypeScript extension retains boundaries and strict lint", async () => {
  for (const extension of ["ts", "tsx", "mts", "cts"]) {
    const from = scopes["worker-storage"].replace(/\.ts$/u, `.${extension}`);
    assert(
      resolved(importType("../api/x.ts"), from).some(
        (diagnostic) => diagnostic.boundaryId === "worker-storage-layers",
      ),
    );
    const config = z
      .object({ rules: z.record(z.string(), z.unknown()) })
      .parse(await eslint.calculateConfigForFile(from));
    assert(config.rules["@typescript-eslint/no-explicit-any"]);
  }
});

void test("source files retain computed-import, glob and URL restrictions", async () => {
  for (const from of [
    ...Object.values(scopes),
    "apps/worker/src/api/example.test.ts",
    "packages/contracts/src/example.test.ts",
  ]) {
    for (const source of [
      "void import(path);",
      'import.meta.glob("./**/*.ts");',
      'const glob = import.meta["glob"];',
    ])
      assert((await diagnostics(source, from)).length > 0, `${from}: ${source}`);
    const source = 'new URL("./fixture", import.meta.url);';
    const isTest = /\.test\.|\/tests\//u.test(from);
    assert.equal((await diagnostics(source, from)).length > 0, !isTest, from);
  }
  assert.deepEqual(await diagnostics('void import((("./x.ts")));', scopes.web), []);
  assert.deepEqual(
    await diagnostics('new URL("./fixture", import.meta.url);', "apps/worker/tests/example.ts"),
    [],
  );
  assert(boundaryTestIgnores.length > 0);
});

void test("undeclared Worker directories fail and the real tree passes", () => {
  assert.deepEqual(checkWorkerLayers(Object.keys(workerLayers)), []);
  for (const directory of ["new-layer", "constructor", "toString", "__proto__"])
    assert.equal(checkWorkerLayers([...Object.keys(workerLayers), directory]).length, 1);
  const directories = readdirSync(new URL("../../apps/worker/src/", import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert(directories.length > 0);
  assert.deepEqual(checkWorkerLayers(directories), []);
});

void test("docs retain architecture rules and the remaining limits", () => {
  const plan = readFileSync(new URL("../../docs/plan.md", import.meta.url), "utf8")
    .split("### 4.2")[1]
    ?.split("### 4.3")[0];
  assert(plan);
  for (const text of [
    "API応答の型・スキーマも使わない",
    "viewer/wasm.ts",
    "scripts/dev",
    "solidcraft-io",
    "宣言した依存",
  ])
    assert(plan.includes(text), text);
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  for (const text of ["require()", "再export", "fetch", "Headers", "エディタ"])
    assert(readme.includes(text), text);
  assert(!readme.includes("Web内の同名フォルダーも拒否"));
});

void test("NodeNext import and require conditions resolve to their actual targets", () => {
  const directory = "apps/worker/src/api/node";
  write(`${directory}/source.mts`);
  write(`${directory}/source.cts`);
  write(
    `${directory}/tsconfig.json`,
    JSON.stringify({
      extends: "../../../tsconfig.json",
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["*.mts", "*.cts"],
    }),
  );
  for (const source of [
    'import { value } from "@madori/worker/conditional";',
    'export { value } from "@madori/worker/conditional";',
  ])
    assert.deepEqual(resolved(source, `${directory}/source.mts`), []);
  for (const source of [
    'import x = require("@madori/worker/conditional");',
    'import type x = require("@madori/worker/conditional");',
  ])
    assert(
      resolved(source, `${directory}/source.mts`).some(
        (diagnostic) => diagnostic.boundaryId === "worker-api-layers",
      ),
      source,
    );
  assert(
    resolved('import { value } from "@madori/worker/conditional";', `${directory}/source.cts`).some(
      (diagnostic) => diagnostic.boundaryId === "worker-api-layers",
    ),
  );
  assert.deepEqual(
    resolved('void import((("@madori/worker/conditional")));', `${directory}/source.cts`),
    [],
  );
});

void test("symlinks cannot disguise the target layer", () => {
  const link = "apps/worker/src/api/linked.ts";
  symlinkSync(join(root, "apps/worker/src/storage/x.ts"), join(root, link));
  assert(
    resolved(importValue("./linked.ts")).some(
      (diagnostic) => diagnostic.boundaryId === "worker-api-layers",
    ),
  );
});

void test("composition exceptions and type-only Store imports remain permitted", async () => {
  for (const scope of [
    "worker-api-entry",
    "worker-objects-entry",
    "worker-workflows-entry",
  ] as const)
    assert.deepEqual(resolved(importValue("../compose.ts"), scopes[scope]), []);
  for (const scope of ["worker-objects", "worker-workflows"] as const)
    assert(
      resolved(importValue("../compose.ts"), scopes[scope]).some(
        (row) => row.boundaryId === "worker-composition-entry",
      ),
    );
  assert.deepEqual(
    resolved(importType("../storage/store.ts", "Store"), scopes["worker-services"]),
    [],
  );
  for (const name of ["store", "d1", "r2"])
    assert.deepEqual(
      resolved(importValue(`./storage/${name}.ts`), scopes["worker-composition"]),
      [],
    );
  for (const from of [scopes["worker-d1"], scopes["worker-r2"], scopes["worker-composition"]])
    assert.deepEqual(
      await diagnostics("type Database = D1Database; type Bucket = R2Bucket;", from),
      [],
    );
  for (const [from, source] of [
    [scopes["worker-owner"], "const id = value as OwnerId;"],
    [scopes["worker-access"], "const identity = value as VerifiedIdentity;"],
  ]) {
    assert(from && source);
    assert.deepEqual(await diagnostics(source, from), []);
  }
});

void test("user services cannot import API values", () => {
  const from = "apps/worker/src/services/users.ts";
  assert(
    resolved(importValue(specifier(from, "apps/worker/src/api/x.ts")), from).some(
      (diagnostic) => diagnostic.boundaryId === "worker-services-layers",
    ),
  );
});

void test("package imports maps keep the leading hash while asset suffixes are removed", () => {
  assert.deepEqual(resolved(importType("#api")), []);
  for (const name of ["#storage", "#storage?raw"])
    assert(
      resolved(importType(name)).some(
        (diagnostic) => diagnostic.boundaryId === "worker-api-layers",
      ),
    );
});

void test("entry scopes retain their layer rules without overlapping the layer scope", () => {
  for (const layer of Object.keys(workerLayers)) {
    const row = typescriptBoundaries.find((entry) => entry.id === `worker-${layer}-layers`);
    assert(row);
    const layerScope = Object.entries(typescriptScopes).find(
      ([name]) => name === `worker-${layer}`,
    )?.[1];
    assert(layerScope);
    for (const [name, scope] of Object.entries(typescriptScopes)) {
      if (name === `worker-${layer}`) continue;
      for (const file of scope.files.filter((file) =>
        file.startsWith(`apps/worker/src/${layer}/`),
      )) {
        assert(
          row.from.some((member) => member === name),
          `${name} retains ${layer} rules`,
        );
        assert(
          layerScope.ignores.some((ignored) => ignored === file),
          `${file} has one scope`,
        );
      }
    }
  }
});

void test("plan layer table declares every enforced Worker layer", () => {
  const plan = readFileSync(new URL("../../docs/plan.md", import.meta.url), "utf8")
    .split("### 4.2")[1]
    ?.split("### 4.3")[0];
  assert(plan);
  for (const layer of Object.keys(workerLayers))
    assert(
      plan
        .split("\n")
        .some(
          (line) =>
            line.startsWith("|") && line.split("|")[1]?.trim().replaceAll("`", "") === `${layer}/`,
        ),
      `${layer} layer table row`,
    );
});
