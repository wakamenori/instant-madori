export const typescriptExtensions = "{ts,tsx,mts,cts}";

const workerLayerScopes = {
  "worker-api": {
    files: [`apps/worker/src/api/**/*.${typescriptExtensions}`],
    ignores: ["apps/worker/src/api/app.ts", "apps/worker/src/api/access.ts"],
  },
  "worker-services": {
    files: [`apps/worker/src/services/**/*.${typescriptExtensions}`],
    ignores: [],
  },
  "worker-storage": {
    files: [`apps/worker/src/storage/**/*.${typescriptExtensions}`],
    ignores: ["apps/worker/src/storage/d1.ts", "apps/worker/src/storage/r2.ts"],
  },
  "worker-geometry": {
    files: [`apps/worker/src/geometry/**/*.${typescriptExtensions}`],
    ignores: [],
  },
  "worker-objects": {
    files: [`apps/worker/src/objects/**/*.${typescriptExtensions}`],
    ignores: ["apps/worker/src/objects/pattern-coordinator.ts"],
  },
  "worker-workflows": {
    files: [`apps/worker/src/workflows/**/*.${typescriptExtensions}`],
    ignores: ["apps/worker/src/workflows/job-workflow.ts"],
  },
};

export const typescriptScopes = {
  web: {
    files: [`apps/web/**/*.${typescriptExtensions}`],
    ignores: [
      "apps/web/src/viewer/wasm.ts",
      "apps/web/src/viewer/*.test.ts",
      `apps/web/vite.config.${typescriptExtensions}`,
    ],
  },
  "web-viewer-tests": { files: ["apps/web/src/viewer/*.test.ts"], ignores: [] },
  "web-wasm": { files: ["apps/web/src/viewer/wasm.ts"], ignores: [] },
  "web-config": { files: [`apps/web/vite.config.${typescriptExtensions}`], ignores: [] },
  ...workerLayerScopes,
  "worker-objects-entry": {
    files: ["apps/worker/src/objects/pattern-coordinator.ts"],
    ignores: [],
  },
  "worker-workflows-entry": { files: ["apps/worker/src/workflows/job-workflow.ts"], ignores: [] },
  "worker-api-entry": { files: ["apps/worker/src/api/app.ts"], ignores: [] },
  "worker-access": { files: ["apps/worker/src/api/access.ts"], ignores: [] },
  "worker-d1": { files: ["apps/worker/src/storage/d1.ts"], ignores: [] },
  "worker-r2": { files: ["apps/worker/src/storage/r2.ts"], ignores: [] },
  "worker-composition": { files: ["apps/worker/src/compose.ts"], ignores: [] },
  "worker-owner": { files: ["apps/worker/src/owner.ts"], ignores: [] },
  "worker-other": {
    files: [`apps/worker/**/*.${typescriptExtensions}`],
    ignores: [
      ...Object.values(workerLayerScopes).flatMap((scope) => scope.files),
      "apps/worker/src/compose.ts",
      "apps/worker/src/owner.ts",
    ],
  },
  contracts: { files: [`packages/contracts/**/*.${typescriptExtensions}`], ignores: [] },
} satisfies Record<string, { files: string[]; ignores: string[] }>;

type TypeScriptScope = keyof typeof typescriptScopes;
const allScopes = Object.keys(typescriptScopes).filter((scope): scope is TypeScriptScope =>
  Object.hasOwn(typescriptScopes, scope),
);

type BoundaryReason = `docs/plan.md §${string}` | `AGENTS.md ${string}`;
type WorkerLayerScope = keyof typeof workerLayerScopes;
type WorkerLayer = WorkerLayerScope extends `worker-${infer Layer}` ? Layer : never;

export const workerLayers: Record<
  WorkerLayer,
  { allowed: WorkerLayer[]; typeOnly: WorkerLayer[]; reason: BoundaryReason }
> = {
  api: {
    allowed: ["services"],
    typeOnly: ["geometry"],
    reason: "docs/plan.md §4.2 API calls services and maps geometry result types to HTTP",
  },
  services: {
    allowed: ["geometry"],
    typeOnly: ["storage"],
    reason:
      "docs/plan.md §4.2 services receive Store operations and call geometry without HTTP handlers",
  },
  storage: {
    allowed: [],
    typeOnly: [],
    reason: "docs/plan.md §4.2 storage only reads and writes D1 and R2",
  },
  geometry: {
    allowed: [],
    typeOnly: [],
    reason: "docs/plan.md §4.2 geometry owns Container connections without business decisions",
  },
  workflows: {
    allowed: ["services"],
    typeOnly: [],
    reason: "docs/plan.md §4.2 workflows call services without storage or Container connections",
  },
  objects: {
    allowed: ["services"],
    typeOnly: [],
    reason: "docs/plan.md §4.2 objects call services and must not connect to Container",
  },
};

export function checkWorkerLayers(directories: readonly string[]): string[] {
  return directories
    .filter((directory) => !Object.hasOwn(workerLayers, directory))
    .map(
      (directory) =>
        `Undeclared Worker layer apps/worker/src/${directory}. Add its allowed dependencies to scripts/check/boundaries.ts (docs/plan.md §4.2).`,
    );
}

type TypeScriptBoundary = {
  id: string;
  from: TypeScriptScope[];
  reason: BoundaryReason;
  message: string;
  /** Also enforced in test files, which otherwise may cross boundaries. */
  appliesToTests?: true;
} & (
  | {
      kind: "imports";
      targets: string[];
      exceptTargets?: string[];
      publicEntry?: { file: string; specifier: string };
      importNamePattern?: string;
      allowTypeImports?: boolean;
    }
  | { kind: "globals"; names: string[] }
  | { kind: "syntax"; selectors: string[] }
);

const workerLayerNames = Object.keys(workerLayers).filter((layer): layer is WorkerLayer =>
  Object.hasOwn(workerLayers, layer),
);
const workerLayerMembers: Record<WorkerLayer, TypeScriptScope[]> = {
  api: ["worker-api-entry", "worker-access"],
  services: [],
  storage: ["worker-d1", "worker-r2"],
  geometry: [],
  objects: ["worker-objects-entry"],
  workflows: ["worker-workflows-entry"],
};
const workerLayerBoundaries: TypeScriptBoundary[] = workerLayerNames.flatMap((layer) => {
  const { allowed, typeOnly, reason } = workerLayers[layer];
  const forbidden = workerLayerNames.filter(
    (target) => target !== layer && !allowed.includes(target) && !typeOnly.includes(target),
  );
  const from: TypeScriptScope[] = [`worker-${layer}`, ...workerLayerMembers[layer]];
  const rows: TypeScriptBoundary[] = [];
  if (forbidden.length) {
    rows.push({
      id: `worker-${layer}-layers`,
      from,
      kind: "imports",
      targets: forbidden.map((target) => `apps/worker/src/${target}/**`),
      reason,
      message: `Worker ${layer} must not import ${forbidden.join(", ")}; use its allowed layers.`,
    });
  }
  if (typeOnly.length) {
    rows.push({
      id: `worker-${layer}-type-only`,
      from,
      kind: "imports",
      targets: typeOnly.map((target) => `apps/worker/src/${target}/**`),
      allowTypeImports: true,
      reason,
      message: `Worker ${layer} may import only types from ${typeOnly.join(", ")}.`,
    });
  }
  return rows;
});

export const typescriptBoundaries: TypeScriptBoundary[] = [
  {
    id: "production-test-imports",
    from: allScopes.filter((scope) => scope !== "web-viewer-tests"),
    kind: "imports",
    targets: ["**/tests/**", "**/*.test", "**/*.test.*"],
    reason: "docs/plan.md §4.2 production files must not depend on test files",
    message: "Production files must not import test files.",
  },
  ...workerLayerBoundaries,
  {
    id: "storage-binding-types",
    from: allScopes.filter(
      (scope) =>
        scope.startsWith("worker-") &&
        !["worker-d1", "worker-r2", "worker-composition"].includes(scope),
    ),
    kind: "globals",
    names: ["D1Database", "R2Bucket", "D1PreparedStatement", "R2ObjectBody"],
    reason: "docs/plan.md §6.1b binding types belong to adapters and composition",
    message: "Use Store operations instead of raw storage binding types.",
  },
  {
    id: "storage-binding-access",
    from: allScopes.filter(
      (scope) => scope.startsWith("worker-") && scope !== "worker-composition",
    ),
    kind: "syntax",
    selectors: [
      "MemberExpression:matches([property.name=/^(DB|BLOBS)$/u][computed=false], [property.value=/^(DB|BLOBS)$/u])",
      "Property[parent.type='ObjectPattern']:matches([key.name=/^(DB|BLOBS)$/u][computed=false], [key.value=/^(DB|BLOBS)$/u])",
      "TSLiteralType > Literal[value=/^(DB|BLOBS)$/u]",
      "ImportDeclaration[source.value='cloudflare:workers'] ImportSpecifier[imported.name='env']",
      "ImportDeclaration[source.value='cloudflare:workers'] ImportNamespaceSpecifier",
      "ImportExpression > Literal.source[value='cloudflare:workers']",
      "ExportNamedDeclaration[source.value='cloudflare:workers'] ExportSpecifier[local.name='env']",
      "ExportAllDeclaration[source.value='cloudflare:workers']",
    ],
    reason: "docs/plan.md §6.1b only composition extracts DB and BLOBS",
    message: "Read DB and BLOBS only in apps/worker/src/compose.ts.",
  },
  {
    id: "worker-composition-entry",
    from: allScopes.filter(
      (scope) =>
        scope.startsWith("worker-") &&
        ![
          "worker-api-entry",
          "worker-objects-entry",
          "worker-workflows-entry",
          "worker-composition",
        ].includes(scope),
    ),
    kind: "imports",
    targets: ["apps/worker/src/compose.ts"],
    allowTypeImports: true,
    reason:
      "docs/plan.md §4.2 only api/app.ts, objects/pattern-coordinator.ts and workflows/job-workflow.ts construct service dependencies",
    message:
      "Only api/app.ts, objects/pattern-coordinator.ts and workflows/job-workflow.ts may import composition functions.",
  },
  {
    id: "worker-store-construction",
    from: allScopes.filter(
      (scope) =>
        scope.startsWith("worker-") &&
        !["worker-storage", "worker-d1", "worker-r2", "worker-composition"].includes(scope),
    ),
    kind: "imports",
    targets: ["apps/worker/src/storage/{store,d1,r2}.ts"],
    allowTypeImports: true,
    reason: "docs/plan.md §6.1b only composition builds Store and adapters",
    message: "Only composition may construct Store and storage adapters.",
  },
  {
    id: "owner-assertions",
    from: allScopes.filter((scope) => scope.startsWith("worker-") && scope !== "worker-owner"),
    kind: "syntax",
    selectors: [
      "TSAsExpression > TSTypeReference.typeAnnotation:matches([typeName.name='OwnerId'], [typeName.right.name='OwnerId'])",
      "TSTypeAssertion > TSTypeReference.typeAnnotation:matches([typeName.name='OwnerId'], [typeName.right.name='OwnerId'])",
    ],
    reason: "docs/plan.md §6.1b direct OwnerId assertions are forbidden",
    message: "Obtain OwnerId through authentication instead of a direct assertion.",
    appliesToTests: true,
  },
  {
    id: "identity-assertions",
    from: allScopes.filter((scope) => scope.startsWith("worker-") && scope !== "worker-access"),
    kind: "syntax",
    selectors: [
      "TSAsExpression > TSTypeReference.typeAnnotation:matches([typeName.name='VerifiedIdentity'], [typeName.right.name='VerifiedIdentity'])",
      "TSTypeAssertion > TSTypeReference.typeAnnotation:matches([typeName.name='VerifiedIdentity'], [typeName.right.name='VerifiedIdentity'])",
    ],
    reason: "docs/plan.md §6.1b only Access verification constructs VerifiedIdentity",
    message: "Obtain VerifiedIdentity by verifying an Access JWT.",
    appliesToTests: true,
  },
  {
    id: "job-execution-assertions",
    from: allScopes.filter((scope) => scope.startsWith("worker-")),
    kind: "syntax",
    selectors: [
      "TSAsExpression > TSTypeReference.typeAnnotation:matches([typeName.name='JobExecutionRight'], [typeName.right.name='JobExecutionRight'])",
      "TSTypeAssertion > TSTypeReference.typeAnnotation:matches([typeName.name='JobExecutionRight'], [typeName.right.name='JobExecutionRight'])",
    ],
    reason: "docs/plan.md §4.6 execution rights require a verified job row",
    message:
      "Obtain JobExecutionRight by claiming or restoring a job instead of a direct assertion.",
    appliesToTests: true,
  },
  {
    id: "never-assertions",
    from: allScopes.filter((scope) => scope.startsWith("worker-")),
    kind: "syntax",
    selectors: [
      "TSAsExpression > TSNeverKeyword.typeAnnotation",
      "TSTypeAssertion > TSNeverKeyword.typeAnnotation",
    ],
    reason: "docs/plan.md §6.1b casts to never would create OwnerId and VerifiedIdentity",
    message: "Do not cast to never; it bypasses branded types such as OwnerId.",
    appliesToTests: true,
  },
  {
    id: "storage-response",
    from: ["worker-storage", "worker-d1", "worker-r2"],
    kind: "imports",
    targets: ["packages/contracts/**"],
    importNamePattern: "(?:Response(?:Schema)?|^ApiError(?:Code)?|^apiError(?:Code)?Schema)$",
    reason: "docs/plan.md §4.2 API maps business results to HTTP responses",
    message: "Storage returns domain data, not API response or error types.",
  },
  {
    id: "storage-unchecked-schemas",
    from: ["worker-storage", "worker-d1", "worker-r2"],
    kind: "syntax",
    selectors: [
      "MemberExpression[object.name='z'][property.name=/^(?:any|custom)$/u]",
      "ImportDeclaration[source.value='zod'] ImportSpecifier[imported.name=/^(?:any|custom)$/u]",
    ],
    reason: "docs/plan.md §6.1b storage validates every row with a checking schema",
    message: "Storage schemas must check values; do not use z.any or z.custom.",
  },
  {
    id: "services-http",
    from: ["worker-services"],
    kind: "globals",
    names: ["Request", "Response"],
    reason: "docs/plan.md §4.2 services must not contain Request or Response",
    message: "Services must not use HTTP Request or Response globals.",
  },
  {
    id: "storage-http",
    from: ["worker-storage", "worker-d1", "worker-r2"],
    kind: "globals",
    names: ["Request", "Response", "fetch", "Headers"],
    reason: "docs/plan.md §4.2 storage only reads and writes D1 and R2 without HTTP",
    message: "Storage must not use HTTP Request, Response, fetch or Headers globals.",
  },
  {
    id: "web-worker",
    from: ["web", "web-viewer-tests", "web-wasm", "web-config"],
    kind: "imports",
    targets: ["apps/worker/**"],
    reason: "docs/plan.md §4.2 web owns the browser; worker owns the server",
    message: "Web must not import Worker.",
    appliesToTests: true,
  },
  {
    id: "web-scripts",
    from: ["web", "web-viewer-tests", "web-wasm"],
    kind: "imports",
    targets: ["scripts/**"],
    reason: "docs/plan.md §4.2 web owns the browser; scripts are development tooling",
    message: "Web must not import development scripts.",
    appliesToTests: true,
  },
  {
    id: "web-config-scripts",
    from: ["web-config"],
    kind: "imports",
    targets: ["scripts/**"],
    exceptTargets: ["scripts/dev/**"],
    reason: "docs/plan.md §4.2 Vite config may import scripts/dev only",
    message: "Vite config may import only development scripts under scripts/dev.",
  },
  {
    id: "worker-web",
    from: allScopes.filter((scope) => scope.startsWith("worker-")),
    kind: "imports",
    targets: ["apps/web/**"],
    reason: "docs/plan.md §4.2 worker owns the server; web owns the browser",
    message: "Worker must not import Web.",
  },
  {
    id: "contracts-apps",
    from: ["contracts"],
    kind: "imports",
    targets: ["apps/**"],
    reason: "docs/plan.md §4.2 contracts contains shared communication schemas and types",
    message: "Shared contracts must not import applications.",
  },
  {
    id: "web-internal-geometry",
    from: ["web", "web-viewer-tests", "web-wasm", "web-config"],
    kind: "imports",
    targets: ["packages/contracts/**"],
    publicEntry: { file: "packages/contracts/src/index.ts", specifier: "@madori/contracts" },
    reason: "docs/plan.md §4.2 Web must not import internal API definitions",
    message: "Use public @madori/contracts exports in web.",
    appliesToTests: true,
  },
  {
    id: "web-viewer-bindings",
    from: ["web", "web-config"],
    kind: "imports",
    targets: ["crates/viewer/pkg/**"],
    reason: "docs/plan.md §4.2 web owns Wasm loading through viewer/wasm.ts",
    message: "Import viewer bindings through viewer/wasm.ts.",
    appliesToTests: true,
  },
];

export const boundaryTestIgnores = [`**/*.test.${typescriptExtensions}`, "**/tests/**"];

export const crateFamilies = {
  cadKernel: { pattern: /^solidcore(?:-ops)?$/u, label: "CAD kernel" },
  uiToolkit: {
    pattern: /^(?:egui(?:[-_].*)?|epaint(?:[-_].*)?|emath|ecolor|eframe|winit)$/u,
    label: "UI toolkit",
  },
  gpu: { pattern: /^wgpu(?:-.*)?$/u, label: "GPU" },
  pluginRuntime: { pattern: /^(?:wasmtime(?:-.*)?|craft-plugin-wasm)$/u, label: "plugin runtime" },
  editingEngine: {
    pattern: /^(?:madori-modeling|solidcraft-(?:engine|doc|kernel|io))$/u,
    label: "editing engine",
  },
} satisfies Record<string, { pattern: RegExp; label: string }>;

type CrateFamily = keyof typeof crateFamilies;

export const viewerWasmBoundary = {
  id: "viewer-wasm-contents",
  crate: "madori-viewer",
  forbidden: ["cadKernel"],
  reason:
    "docs/plan.md §4.2 the delivered viewer contains no CAD kernel, editing engine or UI toolkit code",
  message: "The viewer Wasm must not contain CAD kernel, editing engine or UI toolkit functions.",
} satisfies {
  id: string;
  crate: string;
  forbidden: CrateFamily[];
  reason: BoundaryReason;
  message: string;
};

type RustBoundary = {
  id: string;
  crate: string;
  reason: BoundaryReason;
  message: string;
} & (
  | { kind: "direct"; allowedDirectDeps: string[]; dependencyPrefix?: string }
  | { kind: "graph"; forbidden: Exclude<CrateFamily, "cadKernel">[] }
  | {
      kind: "features";
      target: string;
      dependency: string;
      required: string[];
      forbidden: string[];
    }
);

export const rustBoundaries: RustBoundary[] = [
  {
    id: "display-dependencies",
    crate: "madori-display",
    kind: "direct",
    allowedDirectDeps: [],
    reason: "AGENTS.md 構成と境界; docs/plan.md §4.2 display has no dependencies",
    message: "Display format must have no dependencies.",
  },
  {
    id: "housing-dependencies",
    crate: "madori-housing",
    kind: "direct",
    allowedDirectDeps: ["schemars", "serde", "serde_json"],
    reason:
      "AGENTS.md 構成と境界; docs/plan.md §3.1 and §4.2 housing uses serialization and schema dependencies only",
    message: "Housing may depend only on schemars, serde and serde_json.",
  },
  {
    id: "viewer-solidcraft",
    crate: "madori-viewer",
    kind: "direct",
    dependencyPrefix: "solidcraft-",
    allowedDirectDeps: ["solidcraft-geom", "solidcraft-viewport", "solidcraft-viewport-gpu"],
    reason: "docs/plan.md §4.2 viewer uses only SolidCraft geom, viewport and viewport-gpu",
    message: "Viewer may directly use only SolidCraft geom, viewport and viewport-gpu.",
  },
  {
    id: "viewer-editing",
    crate: "madori-viewer",
    kind: "graph",
    forbidden: ["editingEngine"],
    reason: "docs/plan.md §4.2 viewer draws display data without the editing engine",
    message: "Viewer must not include the editing engine.",
  },
  {
    id: "viewer-ui-toolkit",
    crate: "madori-viewer",
    kind: "graph",
    forbidden: ["uiToolkit"],
    reason: "docs/plan.md §4.2 viewer draws with wgpu and contains no UI toolkit",
    message: "Viewer must not include a UI toolkit.",
  },
  {
    id: "modeling-solidcraft",
    crate: "madori-modeling",
    kind: "direct",
    dependencyPrefix: "solidcraft-",
    allowedDirectDeps: [
      "solidcraft-engine",
      "solidcraft-doc",
      "solidcraft-kernel",
      "solidcraft-io",
    ],
    reason:
      "docs/plan.md §4.2 modeling uses engine, doc and kernel; current solidcraft-io enables external-workspace cache safety (§5.1)",
    message:
      "Modeling SolidCraft dependencies must stay within its documented layers and cache-safety IO exception.",
  },
  {
    id: "geometry-solidcraft",
    crate: "madori-geometry",
    kind: "direct",
    dependencyPrefix: "solidcraft-",
    allowedDirectDeps: [],
    reason: "docs/plan.md §4.2 apps/geometry calls modeling; CAD mapping stays out of HTTP",
    message: "The HTTP entry point must use modeling instead of SolidCraft directly.",
  },
  {
    id: "geometry-ui-toolkit",
    crate: "madori-geometry",
    kind: "graph",
    forbidden: ["uiToolkit", "gpu"],
    reason:
      "docs/plan.md §4.2 geometry is a Container service without UI toolkits or GPU rendering",
    message: "The native geometry service must not include a UI toolkit or GPU rendering.",
  },
  {
    id: "geometry-plugin-runtime",
    crate: "madori-geometry",
    kind: "graph",
    forbidden: ["pluginRuntime"],
    reason: "docs/plan.md §4.2, §5.1 geometry does not execute plugins or include a plugin runtime",
    message: "The native geometry service must not include a plugin runtime.",
  },
  {
    id: "geometry-cache-trust",
    crate: "madori-geometry",
    kind: "features",
    target: "x86_64-unknown-linux-gnu",
    dependency: "solidcraft-io",
    required: ["external-workspace"],
    forbidden: ["trust-unknown-source"],
    reason:
      "docs/plan.md §5.1 disable upstream cache reuse because its fingerprint does not describe this workspace",
    message: "The service must not trust a cache fingerprint from the upstream workspace.",
  },
];
