export const typescriptExtensions = "{ts,tsx,mts,cts}";

const workerLayerScopes = {
  "worker-api": { files: [`apps/worker/src/api/**/*.${typescriptExtensions}`], ignores: [] },
  "worker-services": {
    files: [`apps/worker/src/services/**/*.${typescriptExtensions}`],
    ignores: [],
  },
  "worker-storage": {
    files: [`apps/worker/src/storage/**/*.${typescriptExtensions}`],
    ignores: [],
  },
  "worker-geometry": {
    files: [`apps/worker/src/geometry/**/*.${typescriptExtensions}`],
    ignores: [],
  },
  "worker-objects": {
    files: [`apps/worker/src/objects/**/*.${typescriptExtensions}`],
    ignores: [],
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
  "worker-other": {
    files: [`apps/worker/**/*.${typescriptExtensions}`],
    ignores: Object.values(workerLayerScopes).flatMap((scope) => scope.files),
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
    allowed: ["storage", "geometry"],
    typeOnly: [],
    reason: "docs/plan.md §4.2 services call storage and geometry without HTTP handlers",
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
  | { kind: "imports"; regex: string; importNamePattern?: string; allowTypeImports?: boolean }
  | { kind: "globals"; names: string[] }
);

const workerLayerNames = Object.keys(workerLayers).filter((layer): layer is WorkerLayer =>
  Object.hasOwn(workerLayers, layer),
);
const workerLayerBoundaries: TypeScriptBoundary[] = workerLayerNames.flatMap((layer) => {
  const { allowed, typeOnly, reason } = workerLayers[layer];
  const forbidden = workerLayerNames.filter(
    (target) => target !== layer && !allowed.includes(target) && !typeOnly.includes(target),
  );
  const from: TypeScriptScope[] = [`worker-${layer}`];
  const rows: TypeScriptBoundary[] = [];
  if (forbidden.length) {
    rows.push({
      id: `worker-${layer}-layers`,
      from,
      kind: "imports",
      regex: `^\\.\\.?/(?:[^/]+/)*(?:${forbidden.join("|")})(?:/|$)`,
      reason,
      message: `Worker ${layer} must not import ${forbidden.join(", ")}; use its allowed layers.`,
    });
  }
  if (typeOnly.length) {
    rows.push({
      id: `worker-${layer}-type-only`,
      from,
      kind: "imports",
      regex: `^\\.\\.?/(?:[^/]+/)*(?:${typeOnly.join("|")})(?:/|$)`,
      allowTypeImports: true,
      reason,
      message: `Worker ${layer} may import only types from ${typeOnly.join(", ")}.`,
    });
  }
  return rows;
});

export const typescriptBoundaries: TypeScriptBoundary[] = [
  {
    id: "normalized-specifiers",
    from: allScopes,
    kind: "imports",
    regex: "^/|//|\\\\|^\\./\\.\\.(?:/|$)|/\\.(?:/|$)|(?:^|/)(?!\\.\\.?(?:/|$))[^/]+/\\.\\.(?:/|$)",
    reason: "docs/plan.md §4.2 dependency paths must be normalized",
    message:
      "Use normalized relative module specifiers: no absolute paths or redundant path segments.",
    appliesToTests: true,
  },
  {
    id: "production-test-imports",
    from: allScopes.filter((scope) => scope !== "web-viewer-tests"),
    kind: "imports",
    regex: "(?:^|/)tests(?:/|$)|\\.test(?:\\.[^/]*)?(?:$|[?#])",
    reason: "docs/plan.md §4.2 production files must not depend on test files",
    message: "Production files must not import test files.",
  },
  ...workerLayerBoundaries,
  {
    id: "storage-response",
    from: ["worker-storage"],
    kind: "imports",
    regex: "^(?:@madori/contracts(?:/.*)?|\\.\\.?/(?:[^/]+/)*packages/contracts(?:/.*)?)$",
    importNamePattern: "(?:Response(?:Schema)?|^ApiError(?:Code)?|^apiError(?:Code)?Schema)$",
    reason: "docs/plan.md §4.2 API maps business results to HTTP responses",
    message: "Storage returns domain data, not API response or error types.",
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
    from: ["worker-storage"],
    kind: "globals",
    names: ["Request", "Response", "fetch", "Headers"],
    reason: "docs/plan.md §4.2 storage only reads and writes D1 and R2 without HTTP",
    message: "Storage must not use HTTP Request, Response, fetch or Headers globals.",
  },
  {
    id: "web-worker",
    from: ["web", "web-viewer-tests", "web-wasm", "web-config"],
    kind: "imports",
    regex: "(?:^@madori/worker|^\\.\\.?/(?:[^/]+/)*apps/worker|^(?:\\.\\./)+worker)(?:/|$)",
    reason: "docs/plan.md §4.2 web owns the browser; worker owns the server",
    message: "Web must not import Worker.",
    appliesToTests: true,
  },
  {
    id: "web-scripts",
    from: ["web", "web-viewer-tests", "web-wasm"],
    kind: "imports",
    regex: "^\\.\\.?/(?:[^/]+/)*scripts(?:/|$)",
    reason: "docs/plan.md §4.2 web owns the browser; scripts are development tooling",
    message: "Web must not import development scripts.",
    appliesToTests: true,
  },
  {
    id: "web-config-scripts",
    from: ["web-config"],
    kind: "imports",
    regex: "^\\.\\.?/(?:[^/]+/)*scripts/(?!dev/)",
    reason: "docs/plan.md §4.2 Vite config may import scripts/dev only",
    message: "Vite config may import only development scripts under scripts/dev.",
  },
  {
    id: "worker-web",
    from: allScopes.filter((scope) => scope.startsWith("worker-")),
    kind: "imports",
    regex: "(?:^@madori/web|^\\.\\.?/(?:[^/]+/)*apps/web|^(?:\\.\\./)+web)(?:/|$)",
    reason: "docs/plan.md §4.2 worker owns the server; web owns the browser",
    message: "Worker must not import Web.",
  },
  {
    id: "contracts-apps",
    from: ["contracts"],
    kind: "imports",
    regex: "(?:^@madori/(?:web|worker)|^\\.\\.?/(?:[^/]+/)*apps)(?:/|$)",
    reason: "docs/plan.md §4.2 contracts contains shared communication schemas and types",
    message: "Shared contracts must not import applications.",
  },
  {
    id: "web-internal-geometry",
    from: ["web", "web-viewer-tests", "web-wasm", "web-config"],
    kind: "imports",
    regex:
      "(?:^@madori/contracts/geometry-internal(?:$|[/.])|^\\.\\.?/(?:[^/]+/)*packages/contracts(?:/|$))",
    reason: "docs/plan.md §4.2 Web must not import internal API definitions",
    message: "Use public @madori/contracts exports in web.",
    appliesToTests: true,
  },
  {
    id: "web-viewer-bindings",
    from: ["web", "web-config"],
    kind: "imports",
    regex: "^\\.\\.?/(?:[^/]+/)*crates/viewer/pkg(?:/|$)",
    reason: "docs/plan.md §4.2 web owns Wasm loading through viewer/wasm.ts",
    message: "Import viewer bindings through viewer/wasm.ts.",
    appliesToTests: true,
  },
];

export const boundaryTestIgnores = [`**/*.test.${typescriptExtensions}`, "**/tests/**"];

type RustBoundary = {
  id: string;
  crate: string;
  reason: BoundaryReason;
  message: string;
} & (
  | { kind: "direct"; allowedDirectDeps: string[]; dependencyPrefix?: string }
  | { kind: "graph"; forbiddenDeps: string }
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
    allowedDirectDeps: [],
    reason:
      "AGENTS.md 構成と境界; docs/plan.md §4.2 housing is independent of HTTP, browser, Cloudflare and CAD",
    message: "Housing dependencies need an explicit pure-domain allowlist entry.",
  },
  {
    id: "viewer-solidcraft",
    crate: "madori-viewer",
    kind: "direct",
    dependencyPrefix: "solidcraft-",
    allowedDirectDeps: ["solidcraft-geom", "solidcraft-render", "solidcraft-gpu"],
    reason: "docs/plan.md §4.2 viewer uses only SolidCraft geom, render and gpu",
    message: "Viewer may directly use only SolidCraft geom, render and gpu.",
  },
  {
    id: "viewer-editing",
    crate: "madori-viewer",
    kind: "graph",
    forbiddenDeps:
      "^(?:madori-modeling|solidcraft-(?:engine|doc|kernel|ui.*)|egui(?:-.*)?|eframe|winit)$",
    reason: "docs/plan.md §4.2 viewer must not include modeling, the editing engine or egui UI",
    message: "Viewer must not include modeling, editing or egui crates.",
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
    id: "geometry-ui",
    crate: "madori-geometry",
    kind: "graph",
    forbiddenDeps: "^(?:egui(?:-.*)?|eframe|winit|solidcraft-ui.*)$",
    reason: "docs/plan.md §4.2 geometry is a Container service without upstream UI",
    message: "The native geometry service must not include the upstream UI.",
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
