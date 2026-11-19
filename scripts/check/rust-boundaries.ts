import { execFileSync } from "node:child_process";
import { z } from "zod";
import { crateFamilies, rustBoundaries } from "./boundaries.ts";

const dependencyKind = z.enum(["dev", "build"]).nullable();
export const cargoMetadataSchema = z.object({
  packages: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      dependencies: z.array(z.object({ name: z.string(), kind: dependencyKind })),
    }),
  ),
  workspace_members: z.array(z.string()),
  resolve: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        features: z.array(z.string()),
        deps: z.array(
          z.object({
            pkg: z.string(),
            dep_kinds: z.array(z.object({ kind: dependencyKind })),
          }),
        ),
      }),
    ),
  }),
});
export type CargoMetadata = z.infer<typeof cargoMetadataSchema>;

export function readRustBoundaryFeatures(): Map<string, string> {
  return new Map(
    rustBoundaries
      .filter((row) => row.kind === "features")
      .map((row) => [
        row.id,
        execFileSync(
          "cargo",
          [
            "tree",
            "--locked",
            "-p",
            row.crate,
            "-e",
            "normal,build,features",
            "--prefix",
            "none",
            "--target",
            row.target,
            "--format",
            "{p} features=[{f}]",
          ],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        ),
      ]),
  );
}

export function checkRustBoundaries(
  metadata: CargoMetadata,
  featureTrees: ReadonlyMap<string, string>,
): string[] {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const violations: string[] = [];
  for (const row of rustBoundaries) {
    const root = metadata.packages.find(
      (pkg) => pkg.name === row.crate && metadata.workspace_members.includes(pkg.id),
    );
    if (!root) {
      violations.push(`[${row.id}] Missing workspace crate ${row.crate}. ${row.reason}`);
      continue;
    }
    const fail = (detail: string) =>
      violations.push(`[${row.id}] ${row.message} ${detail} (${row.reason})`);
    if (row.kind === "direct") {
      for (const dependency of root.dependencies) {
        if (dependency.kind === "dev") continue;
        if (row.dependencyPrefix && !dependency.name.startsWith(row.dependencyPrefix)) continue;
        if (!row.allowedDirectDeps.includes(dependency.name))
          fail(`${root.name} -> ${dependency.name}`);
      }
      continue;
    }
    if (row.kind === "features") {
      const tree = featureTrees.get(row.id);
      const features = new Set<string>();
      let found = false;
      for (const line of tree?.split("\n") ?? []) {
        if (!line.startsWith(`${row.dependency} v`)) continue;
        const match = / features=\[([^\]]*)\](?: \(\*\))?$/u.exec(line);
        if (match?.[1] === undefined) {
          fail(`Invalid feature listing for ${row.dependency}`);
          continue;
        }
        found = true;
        for (const feature of match[1].split(",").filter(Boolean)) features.add(feature);
      }
      if (!found) fail(`Missing ${row.dependency} in ${row.crate}'s ${row.target} feature tree`);
      for (const feature of row.required) {
        if (!features.has(feature)) fail(`${row.dependency} requires ${feature}`);
      }
      for (const feature of row.forbidden) {
        if (features.has(feature)) fail(`${row.dependency} enables ${feature}`);
      }
      continue;
    }
    const visited = new Set<string>();
    const pending = [root.id];
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      const node = nodes.get(id);
      const pkg = packages.get(id);
      if (!node || !pkg) {
        fail(`Missing resolved package ${id}`);
        continue;
      }
      for (const family of row.forbidden) {
        const { pattern, label } = crateFamilies[family];
        if (pattern.test(pkg.name)) fail(`${root.name} reaches ${pkg.name} (${label})`);
      }
      for (const dep of node.deps) {
        if (dep.dep_kinds.some((kind) => kind.kind !== "dev")) pending.push(dep.pkg);
      }
    }
  }
  return violations;
}
