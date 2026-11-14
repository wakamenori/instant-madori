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
  for (const name of ["solidcraft-geom", "solidcraft-render", "solidcraft-gpu"])
    addDependency(metadata, "madori-viewer", name);
  for (const name of ["solidcraft-engine", "solidcraft-doc", "solidcraft-io"])
    addDependency(metadata, "madori-modeling", name);
  addDependency(metadata, "madori-geometry", "madori-modeling");
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
    addDependency(metadata, "solidcraft-render", "bridge");
    addDependency(metadata, "bridge", "madori-modeling");
  },
  "modeling-solidcraft": (metadata) =>
    addDependency(metadata, "madori-modeling", "solidcraft-ui-egui"),
  "geometry-solidcraft": (metadata) =>
    addDependency(metadata, "madori-geometry", "solidcraft-kernel"),
  "geometry-ui": (metadata) => addDependency(metadata, "solidcraft-engine", "egui"),
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

void test("direct dependency checks also reject build dependencies and unapproved pure housing dependencies", () => {
  for (const [parent, dependency, id] of [
    ["madori-display", "serde", "display-dependencies"],
    ["madori-housing", "serde", "housing-dependencies"],
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

void test("viewer and geometry reject UI reached through production or build edges", () => {
  for (const root of ["madori-viewer", "madori-geometry"]) {
    for (const forbidden of ["egui", "egui-wgpu", "eframe", "winit", "solidcraft-ui-egui"]) {
      const metadata = compliantMetadata();
      addDependency(metadata, root, "bridge");
      addDependency(metadata, "bridge", forbidden, "build");
      assert(
        checkRustBoundaries(metadata, compliantFeatureTrees()).some((message) =>
          message.includes(`${root} reaches ${forbidden}`),
        ),
      );
    }
  }
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
    (node) => node.id !== "solidcraft-render",
  );
  assert(
    checkRustBoundaries(incomplete, compliantFeatureTrees()).some((message) =>
      message.includes("Missing resolved package solidcraft-render"),
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
