import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { rustBoundaries } from "./boundaries.ts";
import {
  cargoMetadataSchema,
  checkRustBoundaries,
  readRustBoundaryFeatures,
} from "./rust-boundaries.ts";
import type { CargoMetadata } from "./rust-boundaries.ts";

function compliantFeatureTrees() {
  return new Map([["geometry-cache-trust", "solidcraft-io v0.40.0 features=[external-workspace]"]]);
}

function compliantMetadata(): CargoMetadata {
  const metadata: CargoMetadata = { packages: [], workspace_members: [], resolve: { nodes: [] } };
  for (const row of rustBoundaries) {
    if (metadata.workspace_members.includes(row.crate)) continue;
    addPackage(metadata, row.crate);
    metadata.workspace_members.push(row.crate);
  }
  for (const name of ["solidcraft-geom", "solidcraft-viewport", "solidcraft-viewport-gpu"])
    addDependency(metadata, "madori-viewer", name);
  for (const name of ["solidcraft-engine", "solidcraft-doc", "solidcraft-io"])
    addDependency(metadata, "madori-modeling", name);
  addDependency(metadata, "madori-geometry", "madori-modeling");
  addDependency(metadata, "solidcraft-viewport-gpu", "wgpu");
  addDependency(metadata, "solidcraft-engine", "solidcraft-ui-text");
  const io = metadata.resolve.nodes.find((node) => node.id === "solidcraft-io");
  assert(io);
  io.features.push("external-workspace");
  return metadata;
}

function addPackage(metadata: CargoMetadata, name: string) {
  if (metadata.packages.some((pkg) => pkg.id === name)) return;
  metadata.packages.push({ id: name, name, dependencies: [] });
  metadata.resolve.nodes.push({ id: name, features: [], deps: [] });
}

function addDependency(
  metadata: CargoMetadata,
  parent: string,
  name: string,
  kind: "dev" | "build" | null = null,
) {
  addPackage(metadata, name);
  const pkg = metadata.packages.find((pkg) => pkg.id === parent);
  const node = metadata.resolve.nodes.find((node) => node.id === parent);
  assert(pkg && node);
  pkg.dependencies.push({ name, kind });
  node.deps.push({ pkg: name, dep_kinds: [{ kind }] });
}

const violations: Record<string, (metadata: CargoMetadata, trees: Map<string, string>) => void> = {
  "display-dependencies": (metadata) => addDependency(metadata, "madori-display", "serde"),
  "housing-dependencies": (metadata) => addDependency(metadata, "madori-housing", "reqwest"),
  "viewer-solidcraft": (metadata) => addDependency(metadata, "madori-viewer", "solidcraft-io"),
  "viewer-editing": (metadata) => {
    addDependency(metadata, "solidcraft-viewport", "bridge");
    addDependency(metadata, "bridge", "madori-modeling");
  },
  "viewer-ui-toolkit": (metadata) => addDependency(metadata, "solidcraft-viewport", "egui"),
  "modeling-solidcraft": (metadata) =>
    addDependency(metadata, "madori-modeling", "solidcraft-ui-egui"),
  "geometry-solidcraft": (metadata) =>
    addDependency(metadata, "madori-geometry", "solidcraft-kernel"),
  "geometry-ui-toolkit": (metadata) => addDependency(metadata, "solidcraft-engine", "egui"),
  "geometry-plugin-runtime": (metadata) => addDependency(metadata, "solidcraft-engine", "wasmtime"),
  "geometry-cache-trust": (_metadata, trees) => {
    trees.set(
      "geometry-cache-trust",
      "solidcraft-io v0.40.0 features=[external-workspace,trust-unknown-source]",
    );
  },
};

assert.deepEqual(
  Object.keys(violations),
  rustBoundaries.map((row) => row.id),
);
for (const row of rustBoundaries) {
  void test(`Rust boundary ${row.id} passes compliant metadata and reports violations`, () => {
    const metadata = compliantMetadata();
    assert.deepEqual(checkRustBoundaries(metadata, compliantFeatureTrees()), []);
    const violate = violations[row.id];
    assert(violate);
    const trees = compliantFeatureTrees();
    violate(metadata, trees);
    assert(
      checkRustBoundaries(metadata, trees).some(
        (message) => message.startsWith(`[${row.id}]`) && message.includes(row.message),
      ),
    );
  });
}

void test("housing accepts its schema and JSON dependencies and rejects reqwest", () => {
  const metadata = compliantMetadata();
  for (const name of ["schemars", "serde", "serde_json"])
    addDependency(metadata, "madori-housing", name);
  assert.deepEqual(checkRustBoundaries(metadata, compliantFeatureTrees()), []);
  addDependency(metadata, "madori-housing", "reqwest");
  assert(
    checkRustBoundaries(metadata, compliantFeatureTrees()).some(
      (message) => message.startsWith("[housing-dependencies]") && message.includes("reqwest"),
    ),
  );
});

void test("modeling reaches kernel through engine and rejects a direct kernel dependency", () => {
  const allowed = compliantMetadata();
  addDependency(allowed, "solidcraft-engine", "solidcraft-kernel");
  addDependency(allowed, "madori-modeling", "madori-housing");
  assert.deepEqual(checkRustBoundaries(allowed, compliantFeatureTrees()), []);
  for (const kind of [null, "build"] satisfies ("build" | null)[]) {
    const direct = compliantMetadata();
    addDependency(direct, "madori-modeling", "solidcraft-kernel", kind);
    assert(
      checkRustBoundaries(direct, compliantFeatureTrees()).some(
        (message) =>
          message.startsWith("[modeling-solidcraft]") &&
          message.includes("madori-modeling -> solidcraft-kernel"),
      ),
    );
  }
});

void test("direct dependency checks also reject build dependencies", () => {
  for (const [parent, dependency, id] of [
    ["madori-display", "serde", "display-dependencies"],
    ["madori-housing", "reqwest", "housing-dependencies"],
    ["madori-viewer", "solidcraft-engine", "viewer-solidcraft"],
    ["madori-modeling", "solidcraft-ui-egui", "modeling-solidcraft"],
  ]) {
    assert(parent && dependency && id);
    const metadata = compliantMetadata();
    addDependency(metadata, parent, dependency, "build");
    assert(
      checkRustBoundaries(metadata, compliantFeatureTrees()).some((message) =>
        message.startsWith(`[${id}]`),
      ),
    );
  }
});

void test("Rust tests can use dependencies across layers without adding them to production graphs", () => {
  const metadata = compliantMetadata();
  addDependency(metadata, "madori-display", "serde", "dev");
  addDependency(metadata, "madori-housing", "reqwest", "dev");
  addDependency(metadata, "madori-viewer", "madori-modeling", "dev");
  addDependency(metadata, "solidcraft-engine", "egui", "dev");
  assert.deepEqual(checkRustBoundaries(metadata, compliantFeatureTrees()), []);
});

void test("toolkit leak through normal and build edges fails for viewer and geometry", () => {
  for (const [root, id] of [
    ["madori-viewer", "viewer-ui-toolkit"],
    ["madori-geometry", "geometry-ui-toolkit"],
  ]) {
    for (const forbidden of [
      "egui",
      "egui-wgpu",
      "egui_extras",
      "epaint",
      "epaint_default_fonts",
      "emath",
      "ecolor",
      "eframe",
      "winit",
    ]) {
      for (const kind of [null, "build"] satisfies ("build" | null)[]) {
        const metadata = compliantMetadata();
        assert(root);
        addDependency(metadata, root, "bridge", kind);
        addDependency(metadata, "bridge", forbidden, kind);
        assert(
          checkRustBoundaries(metadata, compliantFeatureTrees()).some(
            (message) =>
              message.startsWith(`[${id}]`) &&
              message.includes(`${root} reaches ${forbidden} (UI toolkit)`),
          ),
        );
      }
    }
  }
});

void test("geometry rejects GPU rendering through normal and build edges", () => {
  for (const forbidden of ["wgpu", "wgpu-core"]) {
    for (const kind of [null, "build"] satisfies ("build" | null)[]) {
      const metadata = compliantMetadata();
      addDependency(metadata, "solidcraft-engine", forbidden, kind);
      assert(
        checkRustBoundaries(metadata, compliantFeatureTrees()).some(
          (message) =>
            message.startsWith("[geometry-ui-toolkit]") &&
            message.includes(`madori-geometry reaches ${forbidden} (GPU)`),
        ),
      );
    }
  }
});

void test("UI-free ui-text is allowed in geometry", () => {
  assert.deepEqual(checkRustBoundaries(compliantMetadata(), compliantFeatureTrees()), []);
});

void test("wasmtime leak and craft-plugin-wasm leak fail for geometry", () => {
  for (const forbidden of ["wasmtime", "wasmtime-environ", "craft-plugin-wasm"]) {
    for (const kind of [null, "build"] satisfies ("build" | null)[]) {
      const metadata = compliantMetadata();
      addDependency(metadata, "solidcraft-engine", forbidden, kind);
      assert(
        checkRustBoundaries(metadata, compliantFeatureTrees()).some(
          (message) =>
            message.startsWith("[geometry-plugin-runtime]") &&
            message.includes(`${forbidden} (plugin runtime)`),
        ),
      );
    }
  }
});

void test("viewer viewport-gpu and its wgpu are allowed", () => {
  assert.deepEqual(checkRustBoundaries(compliantMetadata(), compliantFeatureTrees()), []);
});

void test("viewport-egui fails the viewer direct boundary and its egui fails the toolkit boundary", () => {
  const metadata = compliantMetadata();
  addDependency(metadata, "madori-viewer", "solidcraft-viewport-egui");
  addDependency(metadata, "solidcraft-viewport-egui", "egui");
  const messages = checkRustBoundaries(metadata, compliantFeatureTrees());
  assert(messages.some((message) => message.startsWith("[viewer-solidcraft]")));
  assert(messages.some((message) => message.startsWith("[viewer-ui-toolkit]")));
});

void test("viewer rejects every editing engine crate through a rendering dependency", () => {
  for (const name of [
    "madori-modeling",
    "solidcraft-engine",
    "solidcraft-doc",
    "solidcraft-kernel",
    "solidcraft-io",
  ]) {
    const metadata = compliantMetadata();
    addDependency(metadata, "solidcraft-viewport", name);
    assert(
      checkRustBoundaries(metadata, compliantFeatureTrees()).some(
        (message) =>
          message.startsWith("[viewer-editing]") && message.includes(`${name} (editing engine)`),
      ),
    );
  }
});

void test("crate family patterns match whole crate names", () => {
  const metadata = compliantMetadata();
  for (const name of [
    "my-egui",
    "eguiish",
    "epainter",
    "emathx",
    "my-ecolor",
    "wgpuish",
    "wasmtimeish",
    "craft-plugin-wasm-helper",
  ]) {
    addDependency(metadata, "solidcraft-engine", name);
  }
  assert.deepEqual(checkRustBoundaries(metadata, compliantFeatureTrees()), []);
});

void test("cache check requires target features and fails on missing or invalid trees", () => {
  for (const tree of ["solidcraft-io v0.40.0 features=[]", "", "solidcraft-io v0.40.0 malformed"]) {
    assert(
      checkRustBoundaries(compliantMetadata(), new Map([["geometry-cache-trust", tree]])).some(
        (message) => message.includes("requires external-workspace"),
      ),
    );
  }
  assert(
    checkRustBoundaries(compliantMetadata(), new Map()).some((message) =>
      message.includes("Missing solidcraft-io"),
    ),
  );
});

void test("missing workspace crates and incomplete graphs fail instead of skipping boundaries", () => {
  const metadata = compliantMetadata();
  metadata.workspace_members = [];
  assert.equal(
    checkRustBoundaries(metadata, compliantFeatureTrees()).length,
    rustBoundaries.length,
  );
  const incomplete = compliantMetadata();
  incomplete.resolve.nodes = incomplete.resolve.nodes.filter(
    (node) => node.id !== "solidcraft-viewport",
  );
  assert(
    checkRustBoundaries(incomplete, compliantFeatureTrees()).some((message) =>
      message.includes("Missing resolved package solidcraft-viewport"),
    ),
  );
});

void test("real locked Cargo metadata satisfies every Rust boundary", () => {
  const metadata = cargoMetadataSchema.parse(
    JSON.parse(
      execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    ),
  );
  assert.deepEqual(checkRustBoundaries(metadata, readRustBoundaryFeatures()), []);
});

void test("E feature checks use package target trees instead of unified workspace features", () => {
  const metadata = compliantMetadata();
  const missingRequired = new Map([["geometry-cache-trust", "solidcraft-io v0.40.0 features=[]"]]);
  assert(
    checkRustBoundaries(metadata, missingRequired).some((message) =>
      message.includes("requires external-workspace"),
    ),
  );
  const io = metadata.resolve.nodes.find((node) => node.id === "solidcraft-io");
  assert(io);
  io.features.push("trust-unknown-source");
  const cleanTarget = new Map([
    ["geometry-cache-trust", "solidcraft-io v0.40.0 features=[external-workspace]"],
  ]);
  assert.deepEqual(checkRustBoundaries(metadata, cleanTarget), []);
  const unsafeTarget = new Map([
    [
      "geometry-cache-trust",
      "solidcraft-io v0.40.0 features=[external-workspace,trust-unknown-source]",
    ],
  ]);
  assert(
    checkRustBoundaries(metadata, unsafeTarget).some((message) =>
      message.includes("enables trust-unknown-source"),
    ),
  );
});

void test("J HTTP geometry entry point rejects direct SolidCraft dependencies", () => {
  const metadata = compliantMetadata();
  addDependency(metadata, "madori-geometry", "solidcraft-kernel");
  assert(
    checkRustBoundaries(metadata, compliantFeatureTrees()).some((message) =>
      message.startsWith("[geometry-solidcraft]"),
    ),
  );
});

void test("feature targets match the Docker release build", () => {
  const dockerfile = readFileSync(
    new URL("../../apps/geometry/Dockerfile", import.meta.url),
    "utf8",
  );
  for (const row of rustBoundaries) {
    if (row.kind !== "features") continue;
    assert(
      dockerfile.includes(`cargo build --locked --release -p ${row.crate} --target ${row.target}`),
    );
  }
});

void test("feature trees are keyed by boundary id so rows for one crate stay distinct", () => {
  assert.deepEqual(
    [...readRustBoundaryFeatures().keys()],
    rustBoundaries.filter((row) => row.kind === "features").map((row) => row.id),
  );
});
