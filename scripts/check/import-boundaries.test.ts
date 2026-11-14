import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { ESLint } from "eslint";
import { z } from "zod";
import {
  checkWorkerLayers,
  typescriptBoundaries,
  typescriptScopes,
  workerLayers,
} from "./boundaries.ts";

const boundaryRules = new Set([
  "no-restricted-imports",
  "no-restricted-syntax",
  "no-restricted-properties",
  "@typescript-eslint/no-import-type-side-effects",
  "no-restricted-globals",
  "@typescript-eslint/no-restricted-types",
]);
const eslint = new ESLint({
  ruleFilter: ({ ruleId }) => boundaryRules.has(ruleId),
  overrideConfig: {
    languageOptions: { parserOptions: { projectService: false, project: false } },
  },
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
  "worker-api-entry": "apps/worker/src/api/app.ts",
  "worker-access": "apps/worker/src/api/access.ts",
  "worker-d1": "apps/worker/src/storage/d1.ts",
  "worker-r2": "apps/worker/src/storage/r2.ts",
  "worker-composition": "apps/worker/src/compose.ts",
  "worker-owner": "apps/worker/src/owner.ts",
  "worker-user-service": "apps/worker/src/services/users.ts",
  "worker-other": "apps/worker/src/index.ts",
  contracts: "packages/contracts/src/index.ts",
};
const importType = (specifier: string, name = "Domain") =>
  `import type { ${name} } from ${JSON.stringify(specifier)};`;
const importValue = (specifier: string) => `import { value } from ${JSON.stringify(specifier)};`;

const workerLayerPermissions: Record<
  keyof typeof workerLayers,
  { allowed: string[]; typeOnly: string[] }
> = {
  api: { allowed: ["services"], typeOnly: ["geometry"] },
  services: { allowed: ["geometry"], typeOnly: ["storage"] },
  storage: { allowed: [], typeOnly: [] },
  geometry: { allowed: [], typeOnly: [] },
  objects: { allowed: ["services"], typeOnly: [] },
};
type BoundaryCases = { rejected: string[]; allowed: string[] };
const workerLayerCases = Object.fromEntries<BoundaryCases>(
  Object.entries(workerLayerPermissions).flatMap(([layer, { allowed, typeOnly }]) => {
    const forbidden = Object.keys(workerLayerPermissions).filter(
      (target) => target !== layer && !allowed.includes(target) && !typeOnly.includes(target),
    );
    const specifiers = (target: string) => [
      `../${target}/x.ts`,
      `../../src/${target}/x.ts`,
      `../${target}/nested/x.ts`,
    ];
    const runtimeImports = (specifier: string) => [
      importValue(specifier),
      `void import(${JSON.stringify(specifier)});`,
      `export { value } from ${JSON.stringify(specifier)};`,
    ];
    const typeImports = (specifier: string) => [
      importType(specifier),
      `type X = import(${JSON.stringify(specifier)}).Domain;`,
      `export type { Domain } from ${JSON.stringify(specifier)};`,
    ];
    const rows: [string, BoundaryCases][] = [
      [
        `worker-${layer}-layers`,
        {
          rejected: forbidden.flatMap((target) =>
            specifiers(target).flatMap((specifier) => [
              ...runtimeImports(specifier),
              ...typeImports(specifier),
            ]),
          ),
          allowed: [
            ...[layer, ...allowed].flatMap((target) =>
              specifiers(target).flatMap((specifier) => [
                ...runtimeImports(specifier),
                ...typeImports(specifier),
              ]),
            ),
            ...typeOnly.flatMap((target) => specifiers(target).flatMap(typeImports)),
            importValue("../log.ts"),
            importType("@madori/contracts", "Project"),
          ],
        },
      ],
    ];
    if (typeOnly.length) {
      rows.push([
        `worker-${layer}-type-only`,
        {
          rejected: typeOnly.flatMap((target) => specifiers(target).flatMap(runtimeImports)),
          allowed: typeOnly.flatMap((target) => specifiers(target).flatMap(typeImports)),
        },
      ]);
    }
    return rows;
  }),
);
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

const cases: Record<string, BoundaryCases> = {
  "normalized-specifiers": {
    rejected: [
      "./../../worker/src/api/app.ts",
      "../../web/../worker/src/api/app.ts",
      "../../scripts/dev/../shared/repository.ts",
      "../../../packages//contracts/src/generated/geometry-internal.ts",
      "../../scripts/dev//../shared/repository.ts",
      "../../../../crates/viewer//pkg/madori_viewer.js",
      "../..//worker/src/api/app.ts",
      "../..//web/src/api.ts",
      "..\\storage\\projects.ts",
      "/repo/apps/worker/src/storage/revisions.ts",
      "/repo/apps/web/src/api.ts",
    ].map(importValue),
    allowed: [importValue("./x.ts"), importValue("../x.ts")],
  },
  "production-test-imports": {
    rejected: [
      "./tests/helper.ts",
      "./projects.test.ts",
      "./projects.test.js",
      "./projects.test",
    ].map(importValue),
    allowed: [
      importValue("./projects.ts"),
      importValue("./testing.ts"),
      importValue("./test-utils.ts"),
    ],
  },
  ...workerLayerCases,
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
  "worker-composition-entry": {
    rejected: [importValue("../compose.ts"), 'export { serviceDeps } from "../compose.ts";'],
    allowed: [importType("../compose.ts", "Dependencies"), importValue("../runtime.ts")],
  },
  "worker-store-construction": {
    rejected: [
      importValue("../storage/store.ts"),
      importValue("../storage/d1.ts"),
      importValue("../storage/r2.ts"),
    ],
    allowed: [importValue("../runtime.ts")],
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
  "never-assertions": {
    rejected: ["const id: OwnerId = value as never;", "const id: OwnerId = <never>value;"],
    allowed: ["const unreachable: never = value;", "const checked = value satisfies never;"],
  },
  "storage-response": {
    rejected: [
      importType("@madori/contracts", "ProjectResponse"),
      'import type { RevisionListResponse as Page } from "@madori/contracts";',
      importType("../../../../packages/contracts/src/index.ts", "PatternStateResponse"),
      'import * as contracts from "@madori/contracts";',
      'export type { ProjectResponse } from "@madori/contracts";',
      'type X = import("@madori/contracts").ProjectResponse.foo;',
      importType("@madori/contracts", "ApiError"),
      importType("@madori/contracts", "ApiErrorCode"),
      'import { apiErrorSchema } from "@madori/contracts";',
      'import { apiErrorCodeSchema } from "@madori/contracts";',
    ],
    allowed: [importType("@madori/contracts", "Project"), importValue("./rows.ts")],
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
  "web-worker": {
    rejected: [
      "../../worker/src/api/app.ts",
      "../../../worker/src/api/app.ts",
      "../../../apps/worker/src/api/app.ts",
      "@madori/worker",
      "@madori/worker/api",
    ].map(importValue),
    allowed: [
      importType("@madori/contracts", "Project"),
      importValue("./viewer/wasm.ts"),
      importValue("./worker/pool.ts"),
      importValue("./worker"),
    ],
  },
  "web-scripts": {
    rejected: ["../../../scripts/shared/repository.ts", "../../scripts/dev/local-access.ts"].map(
      importValue,
    ),
    allowed: [importType("@madori/contracts", "Project"), importValue("./viewer/wasm.ts")],
  },
  "web-config-scripts": {
    rejected: ["../../scripts/shared/repository.ts", "../../scripts/check/check.ts"].map(
      importValue,
    ),
    allowed: [importValue("../../scripts/dev/local-access.ts"), importValue("vite")],
  },
  "worker-web": {
    rejected: [
      "../../web/src/api.ts",
      "../../../apps/web/src/api.ts",
      "@madori/web",
      "@madori/web/viewer",
    ].map(importValue),
    allowed: [
      importType("@madori/contracts", "Project"),
      importValue("zod"),
      importValue("./web/x.ts"),
      importValue("./web"),
    ],
  },
  "contracts-apps": {
    rejected: [
      "../../../apps/web/src/api.ts",
      "../../../apps/worker/src/api/app.ts",
      "@madori/worker",
      "@madori/web/api",
    ].map(importValue),
    allowed: [importValue("zod"), importValue("./generated/display.ts")],
  },
  "web-internal-geometry": {
    rejected: [
      "@madori/contracts/geometry-internal",
      "../../../packages/contracts/src/generated/geometry-internal.ts",
      "../../../packages/contracts/src/generated/geometry-bodies.ts",
      "../../../packages/contracts/src/generated/geometry-internal.schema.json",
      "../../../packages/contracts/src/generated/geometry-internal.js",
    ].map(importValue),
    allowed: [importValue("@madori/contracts")],
  },
  "web-viewer-bindings": {
    rejected: [importValue("../../../../crates/viewer/pkg/madori_viewer.js")],
    allowed: [importValue("./viewer/wasm.ts")],
  },
};

async function diagnostics(source: string, filePath: string) {
  const results = await eslint.lintText(source, { filePath });
  assert.equal(results.length, 1);
  const messages = results.flatMap((result) => result.messages);
  assert(!messages.some((message) => message.fatal), JSON.stringify(messages));
  return messages.filter((message) => message.ruleId && boundaryRules.has(message.ruleId));
}

assert.deepEqual(
  Object.keys(cases),
  typescriptBoundaries.map((row) => row.id),
);
for (const row of typescriptBoundaries) {
  void test(`TypeScript boundary ${row.id} rejects violations and allows its dependencies`, async () => {
    const fixture = cases[row.id];
    assert(fixture);
    for (const scope of row.from) {
      const filePath = scopes[scope];
      for (const source of fixture.rejected) {
        const messages = await diagnostics(source, filePath);
        assert(
          messages.some((message) => message.message.includes(row.message)),
          `${filePath}: ${source}\n${JSON.stringify(messages)}`,
        );
      }
      for (const source of fixture.allowed) {
        assert.deepEqual(await diagnostics(source, filePath), [], `${filePath}: ${source}`);
      }
    }
  });
}

void test("production exceptions preserve all other web boundaries", async () => {
  assert.deepEqual(
    await diagnostics(
      importValue("../../../../crates/viewer/pkg/madori_viewer.js"),
      scopes["web-wasm"],
    ),
    [],
  );
  for (const source of cases["web-internal-geometry"]?.rejected ?? []) {
    assert(
      (await diagnostics(source, scopes["web-wasm"])).some((message) =>
        message.message.includes("Use public"),
      ),
    );
  }
});

void test("test files may cross layers except rows marked for tests", async () => {
  for (const row of typescriptBoundaries) {
    if (row.appliesToTests) continue;
    const fixture = cases[row.id];
    assert(fixture);
    for (const scope of row.from) {
      const path = scopes[scope].replace(/\.tsx?$/u, ".test.ts");
      for (const source of fixture.rejected) {
        const messages = await diagnostics(source, path);
        if (row.id === "web-config-scripts") {
          assert.equal(messages.length, 1, `${path}: ${source}`);
          assert.equal(messages[0]?.ruleId, "no-restricted-imports");
          assert(messages[0]?.message.includes("Web must not import development scripts."));
        } else assert.deepEqual(messages, [], `${path}: ${source}`);
      }
    }
  }
  assert.deepEqual(
    await diagnostics(importValue("../src/api/http.ts"), "apps/worker/tests/rpc/example.ts"),
    [],
  );
  const marked = typescriptBoundaries.filter((row) => row.appliesToTests);
  assert(marked.length > 0);
  for (const row of marked) {
    for (const source of cases[row.id]?.rejected ?? []) {
      for (const path of ["owner-assertions", "identity-assertions", "never-assertions"].includes(
        row.id,
      )
        ? ["apps/worker/src/services/example.test.ts", "apps/worker/tests/rpc/example.ts"]
        : row.id === "web-viewer-bindings"
          ? ["apps/web/src/api.test.ts", "apps/web/tests/x.ts"]
          : ["apps/web/src/viewer/viewport-session.test.ts", "apps/web/tests/x.ts"]) {
        assert(
          (await diagnostics(source, path)).some((m) => m.message.includes(row.message)),
          `${path}: ${source}`,
        );
      }
    }
  }
});

void test("nested source directories still inherit both app and layer boundaries", async () => {
  for (const [filePath, source, message] of [
    [
      "apps/worker/src/api/nested/handler.ts",
      importType("../../storage/projects.ts"),
      "Worker api must not import",
    ],
    [
      "apps/worker/src/storage/nested/query.ts",
      importType("../../../src/services/projects.ts"),
      "Worker storage must not import",
    ],
    [
      "apps/worker/src/services/nested/action.ts",
      importValue("../../../../web/src/api.ts"),
      "Worker must not import",
    ],
    [
      "apps/web/src/viewer/nested/view.ts",
      importValue("../../../../../scripts/check/check.ts"),
      "Web must not import",
    ],
  ]) {
    assert(filePath && source && message);
    assert(
      (await diagnostics(source, filePath)).some((diagnostic) =>
        diagnostic.message.includes(message),
      ),
    );
  }
});

void test("A alternate module syntax obeys import boundaries", async () => {
  for (const row of typescriptBoundaries.filter((row) => row.kind === "imports")) {
    const source = cases[row.id]?.rejected[0];
    assert(source);
    const specifier = /"([^"]+)"/u.exec(source)?.[1];
    assert(specifier);
    for (const scope of row.from) {
      const variants: string[] = [
        `void import(${JSON.stringify(specifier)});`,
        ...(!row.allowTypeImports
          ? [`type X = import(${JSON.stringify(specifier)}).ProjectResponse;`]
          : []),
      ];
      for (const variant of variants) {
        assert(
          (await diagnostics(variant, scopes[scope])).some((m) => m.message.includes(row.message)),
          variant,
        );
      }
    }
  }
  for (const path of Object.values(scopes)) {
    assert((await diagnostics("void import(path);", path)).length > 0, path);
    assert.deepEqual(await diagnostics('void import("zod");', path), [], path);
  }
  assert.deepEqual(
    await diagnostics(
      'type X = import("../geometry/geometry-protocol.ts").GeometryResult;',
      scopes["worker-api"],
    ),
    [],
  );
});

void test("B unnormalized specifiers are rejected in every scope", async () => {
  for (const path of Object.values(scopes)) {
    for (const specifier of [
      "./../../worker/src/api/app.ts",
      "../../web/../worker/src/api/app.ts",
      "../../scripts/dev/../shared/repository.ts",
      "./x/./module.ts",
    ]) {
      assert((await diagnostics(importValue(specifier), path)).length > 0, `${path}: ${specifier}`);
    }
    for (const specifier of [
      "../../worker-like/x.ts",
      "./x.ts",
      "../x.ts",
      "../../x.ts",
      "@scope/lib",
      "./dot.name/x.ts",
    ]) {
      assert.deepEqual(
        await diagnostics(importValue(specifier), path),
        [],
        `${path}: ${specifier}`,
      );
    }
  }
});

void test("C and J web and Vite use only public contracts and wrapped viewer bindings", async () => {
  for (const path of [scopes.web, scopes["web-config"]]) {
    for (const specifier of [
      "../../../packages/contracts/src/generated/geometry-bodies.ts",
      "../../../packages/contracts/src/generated/geometry-internal.schema.json",
      "../../../packages/contracts/src/generated/geometry-internal.js",
      "../../../packages/contracts/src/index.ts",
      "@madori/contracts/geometry-internal",
      "../../../crates/viewer/pkg/madori_viewer.js",
    ]) {
      assert((await diagnostics(importValue(specifier), path)).length > 0, `${path}: ${specifier}`);
    }
  }
});

void test("D storage rejects response schemas but permits domain schemas and display content type", async () => {
  assert(
    (
      await diagnostics(
        'import { projectResponseSchema } from "@madori/contracts";',
        scopes["worker-storage"],
      )
    ).length > 0,
  );
  assert.deepEqual(
    await diagnostics(
      'import { patternSchema, projectSchema, revisionSchema, userSchema, displayContentType } from "@madori/contracts";',
      scopes["worker-storage"],
    ),
    [],
  );
});

void test("F every TypeScript extension inherits base lint and boundary rules", async () => {
  for (const extension of ["ts", "tsx", "mts", "cts"]) {
    for (const [scope, path] of Object.entries(scopes)) {
      const filePath = path.replace(/\.ts$/u, `.${extension}`);

      assert(
        (
          await diagnostics(
            importValue(
              scope.startsWith("web") && filePath.includes(".test.")
                ? "@madori/contracts/geometry-internal"
                : scope === "contracts"
                  ? "../../../apps/web/src/api.ts"
                  : scope.startsWith("web")
                    ? "../../../worker/src/index.ts"
                    : "../../../web/src/api.ts",
            ),
            filePath,
          )
        ).length > 0,
        filePath,
      );
      const config = z
        .object({ rules: z.record(z.string(), z.unknown()) })
        .parse(await eslint.calculateConfigForFile(filePath));
      assert(config.rules["@typescript-eslint/no-explicit-any"], filePath);
    }
  }
});

void test("G HTTP globals cannot be accessed through self, destructuring, or typeof", async () => {
  for (const path of [scopes["worker-services"], scopes["worker-storage"]]) {
    for (const source of [
      "self.Response.json({});",
      "const { Response } = globalThis;",
      "const { Request: Input } = self;",
      "type X = InstanceType<typeof Response>;",
      "type X = typeof Request;",
      "type X = typeof globalThis.Response;",
      "type X = typeof self.Request;",
      "type X = self.Response;",
    ]) {
      assert((await diagnostics(source, path)).length > 0, `${path}: ${source}`);
    }
  }
});

void test("H only immediate viewer tests may load viewer bindings directly", async () => {
  const source = importValue("../../../../crates/viewer/pkg/madori_viewer.js");
  for (const path of [
    "apps/web/src/api.test.ts",
    "apps/web/tests/example.ts",
    "apps/web/src/viewer/nested/example.test.ts",
    "apps/web/src/viewer/example.test.tsx",
    "apps/web/src/viewer/example.test.mts",
    "apps/web/src/viewer/example.test.cts",
  ]) {
    assert((await diagnostics(source, path)).length > 0, path);
  }
  assert.deepEqual(await diagnostics(source, "apps/web/src/viewer/viewport-session.test.ts"), []);
});

void test("I inline-only type imports cannot emit a runtime geometry import", async () => {
  assert(
    (
      await diagnostics(
        'import { type GeometryResult } from "../geometry/geometry-protocol.ts";',
        scopes["worker-api"],
      )
    ).length > 0,
  );
});

void test("J objects call only services and reject geometry types and Container connections", async () => {
  const path = "apps/worker/src/objects/pattern.ts";
  assert((await diagnostics(importValue("../geometry/geometry-client.ts"), path)).length > 0);
  assert((await diagnostics(importType("../geometry/geometry-protocol.ts"), path)).length > 0);
  assert.deepEqual(await diagnostics(importValue("../services/projects.ts"), path), []);
});

void test("K documented rules include UI, viewer loading, scripts, and cache safety", () => {
  const section = readFileSync(new URL("../../docs/plan.md", import.meta.url), "utf8")
    .split("### 4.2")[1]
    ?.split("### 4.3")[0];
  assert(section);
  for (const text of ["apps/geometry` には", "viewer/wasm.ts", "scripts/dev", "solidcraft-io"])
    assert(section.includes(text), text);
});

void test("L docs describe coordinated rule changes and remaining checker limits", () => {
  const agents = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert(agents.includes("検査を通すことだけを目的"));
  for (const text of ["require()", "再export", "fetch", "Headers", "Web内の同名フォルダー"])
    assert(readme.includes(text), text);
});

void test("Worker layer permissions apply to nested source files", async () => {
  for (const [layer, { allowed, typeOnly }] of Object.entries(workerLayerPermissions)) {
    for (const target of Object.keys(workerLayerPermissions)) {
      const path = `apps/worker/src/${layer}/nested/example.ts`;
      const specifier = `../../${target}/x.ts`;
      for (const source of [importValue(specifier), `void import(${JSON.stringify(specifier)});`]) {
        const messages = await diagnostics(source, path);
        if (target === layer || allowed.includes(target)) assert.deepEqual(messages, [], source);
        else assert(messages.length > 0, `${path}: ${source}`);
      }
      const source = importType(specifier);
      const messages = await diagnostics(source, path);
      if (target === layer || allowed.includes(target) || typeOnly.includes(target))
        assert.deepEqual(messages, [], source);
      else assert(messages.length > 0, `${path}: ${source}`);
    }
  }
});

void test("undeclared Worker directories fail while declared layers and the real tree pass", () => {
  assert.deepEqual(checkWorkerLayers(Object.keys(workerLayers)), []);
  for (const directory of ["new-layer", "constructor", "toString", "__proto__"]) {
    const violations = checkWorkerLayers([...Object.keys(workerLayers), directory]);
    assert.equal(violations.length, 1);
    assert(violations[0]?.includes(`apps/worker/src/${directory}`));
  }
  const directories = readdirSync(new URL("../../apps/worker/src/", import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert(directories.length > 0);
  assert.deepEqual(checkWorkerLayers(directories), []);
});

void test("review 1 duplicate separators and backslashes cannot bypass normalization", async (t) => {
  for (const [scope, specifier] of [
    ["web", "../../../packages//contracts/src/generated/geometry-internal.ts"],
    ["web-config", "../../scripts/dev//../shared/repository.ts"],
    ["web", "../../../../crates/viewer//pkg/madori_viewer.js"],
    ["web", "../..//worker/src/api/app.ts"],
    ["worker-api", "../..//web/src/api.ts"],
    ["worker-api", "..\\storage\\projects.ts"],
  ] satisfies [keyof typeof scopes, string][]) {
    await t.test(`${scope} ${specifier}`, async () => {
      const messages = await diagnostics(importType(specifier), scopes[scope]);
      assert(
        messages.some((message) =>
          message.message.includes("normalized relative module specifiers"),
        ),
      );
    });
  }
});

void test("review 2 glob and module-relative URLs cannot load code outside import checks", async (t) => {
  for (const source of [
    "import.meta.glob(`../../worker/src/**/*.ts`);",
    'import.meta.glob("./**/*.ts", { base: "../../worker/src" });',
    "import.meta.glob([`../../worker/src/**/*.ts`]);",
    'import.meta["glob"]("./**/*.ts", { base: "../../worker/src" });',
    "new URL(`../../worker/src/api/app.ts`, import.meta.url);",
    'new URL("./safe.ts", import.meta.url);',
  ]) {
    await t.test(source, async () => {
      assert((await diagnostics(source, scopes.web)).length > 0, source);
    });
  }
});

void test("review 3 inline type re-exports must use a type-only declaration", async () => {
  const source = 'export { type GeometryResult } from "../geometry/geometry-protocol.ts";';
  const messages = await diagnostics(source, scopes["worker-api"]);
  assert(messages.some((message) => message.ruleId === "no-restricted-syntax"));
  assert.deepEqual(
    await diagnostics(
      'export type { GeometryResult } from "../geometry/geometry-protocol.ts";',
      scopes["worker-api"],
    ),
    [],
  );
});

void test("review 4 every Worker scope rejects Web and viewer tests reject Worker and scripts", async (t) => {
  const row = typescriptBoundaries.find((row) => row.id === "worker-web");
  assert(row);
  assert.deepEqual(
    row.from,
    Object.keys(typescriptScopes).filter((scope) => scope.startsWith("worker-")),
  );
  for (const specifier of [
    "../../../worker/src/api/app.ts",
    "../../../../scripts/check/check.ts",
  ]) {
    await t.test(specifier, async () => {
      assert((await diagnostics(importValue(specifier), scopes["web-viewer-tests"])).length > 0);
    });
  }
});

void test("brand cast rows cover their intended Worker scopes and test files", () => {
  const workerScopes = Object.keys(typescriptScopes).filter((scope) => scope.startsWith("worker-"));
  const expected = {
    "owner-assertions": workerScopes.filter((scope) => scope !== "worker-owner"),
    "identity-assertions": workerScopes.filter((scope) => scope !== "worker-access"),
    "never-assertions": workerScopes,
  };
  for (const [id, from] of Object.entries(expected)) {
    const row = typescriptBoundaries.find((row) => row.id === id);
    assert(row, id);
    assert.deepEqual(row.from, from, id);
    assert.equal(row.appliesToTests, true, id);
  }
});

void test("review 5 package subpaths are not mistaken for relative layers or apps", async (t) => {
  for (const path of Object.values(scopes)) {
    for (const specifier of [
      "@opentelemetry/api",
      "firebase/storage",
      "library/services",
      "library/geometry",
      "library/objects",
      "library/apps/worker",
      "library/apps/web",
      "library/scripts/shared",
      "library/packages/contracts",
      "library/crates/viewer/pkg",
    ]) {
      await t.test(`${path} ${specifier}`, async () => {
        assert.deepEqual(await diagnostics(importValue(specifier), path), []);
      });
    }
  }
});

void test("review 6 dynamic imports and import types match paths case-insensitively", async (t) => {
  for (const source of [
    'void import("../../../Packages/Contracts/src/generated/geometry-internal.ts");',
    'type X = import("../../../Packages/Contracts/src/generated/geometry-internal.ts").Domain;',
  ]) {
    await t.test(source, async () => {
      assert((await diagnostics(source, scopes.web)).length > 0, source);
    });
  }
});

void test("review 7 plan explicitly forbids API response types and schemas in storage", () => {
  const section = readFileSync(new URL("../../docs/plan.md", import.meta.url), "utf8")
    .split("### 4.2")[1]
    ?.split("### 4.3")[0];
  assert(section?.includes("API応答の型・スキーマも使わない"));
});

void test("review 8 production code cannot depend on test files", async (t) => {
  for (const [scope, path] of Object.entries(scopes)) {
    if (scope === "web-viewer-tests") continue;
    for (const specifier of [
      "./tests/helper.ts",
      "./projects.test.ts",
      "./projects.test.js",
      "./projects.test",
    ]) {
      await t.test(`${path} ${specifier}`, async () => {
        assert((await diagnostics(importValue(specifier), path)).length > 0);
      });
    }
  }
});

void test("source files ban glob and file URLs; test files may read fixtures by URL", async () => {
  const sourcePaths = Object.values(scopes).filter((path) => !/\.test\.|\/tests\//u.test(path));
  assert(sourcePaths.length > 0);
  for (const path of sourcePaths) {
    for (const source of [
      'import.meta.glob("./**/*.ts");',
      "import.meta.glob(`./**/*.ts`);",
      'import.meta.glob(["./**/*.ts"]);',
      'import.meta.glob("./**/*.ts", { base: "../../worker/src" });',
      'const load = import.meta["glob"];',
    ])
      assert(
        (await diagnostics(source, path)).some((m) => m.message.includes("import.meta.glob")),
        `${path}: ${source}`,
      );
    for (const source of [
      "new URL(`./fixture.txt`, import.meta.url);",
      'new URL("./x.ts", import.meta.url);',
    ])
      assert(
        (await diagnostics(source, path)).some((m) => m.message.includes("new URL")),
        `${path}: ${source}`,
      );
    assert.deepEqual(await diagnostics('new URL("/api", "https://example.test");', path), [], path);
  }
  for (const path of [
    "apps/web/src/viewer/viewport-session.test.ts",
    "apps/web/src/other.test.ts",
    "apps/worker/tests/support/local-worker.ts",
    "apps/worker/tests/other.ts",
  ]) {
    assert.deepEqual(
      await diagnostics('new URL("../fixtures/x.mdsp", import.meta.url);', path),
      [],
      path,
    );
    assert(
      (await diagnostics('import.meta.glob("./**/*.ts");', path)).some((m) =>
        m.message.includes("import.meta.glob"),
      ),
      path,
    );
  }
});

void test("storage composition exceptions permit only their intended entry points", async () => {
  for (const path of [scopes["worker-d1"], scopes["worker-r2"], scopes["worker-composition"]]) {
    assert.deepEqual(
      await diagnostics("type Database = D1Database; type Bucket = R2Bucket;", path),
      [],
    );
  }
  for (const source of cases["storage-binding-access"]?.rejected ?? []) {
    assert.deepEqual(await diagnostics(source, scopes["worker-composition"]), []);
  }
  assert.deepEqual(
    await diagnostics('import { serviceDeps } from "../compose.ts";', scopes["worker-api-entry"]),
    [],
  );
  assert.deepEqual(
    await diagnostics('import * as deps from "./deps.ts";', scopes["worker-services"]),
    [],
  );
  for (const specifier of ["./storage/store.ts", "./storage/d1.ts", "./storage/r2.ts"]) {
    assert.deepEqual(await diagnostics(importValue(specifier), scopes["worker-composition"]), []);
  }
  assert.deepEqual(
    await diagnostics("const verified = value as VerifiedIdentity;", scopes["worker-access"]),
    [],
  );
  assert.deepEqual(await diagnostics("const id = value as OwnerId;", scopes["worker-owner"]), []);
  assert.deepEqual(
    await diagnostics(
      'import type { Store } from "../storage/store.ts";',
      scopes["worker-services"],
    ),
    [],
  );
});
