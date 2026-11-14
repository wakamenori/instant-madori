import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";
import { geometryInternal } from "../../packages/contracts/src/generated/geometry-internal.ts";
import { readUpstreamPin, repositoryRoot } from "../shared/repository.ts";
import { checkWorkerLayers } from "./boundaries.ts";
import { assertStagingBindings, upstreamFilePath } from "./layout-contract.ts";
import {
  cargoMetadataSchema,
  checkRustBoundaries,
  readRustBoundaryFeatures,
} from "./rust-boundaries.ts";

const workerLayerViolations = checkWorkerLayers(
  readdirSync(new URL("apps/worker/src/", repositoryRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
if (workerLayerViolations.length) throw new Error(workerLayerViolations.join("\n"));

const pin = readUpstreamPin();
const tree = execFileSync("git", ["ls-tree", "-rz", pin.commit], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
const patches = new Set(pin.localPatches);
const upstreamPaths = new Set<string>();
let checked = 0;
for (const entry of tree.split("\0").filter(Boolean)) {
  const [metadata, path] = z.tuple([z.string(), z.string()]).parse(entry.split("\t"));
  const [mode, type, expected] = z
    .tuple([z.string(), z.string(), z.string()])
    .parse(metadata.split(" "));
  upstreamPaths.add(path);
  if (type !== "blob") throw new Error(`Unexpected upstream object: ${path}`);
  const target = upstreamFilePath(repositoryRoot, path);
  const stat = lstatSync(target);
  if (patches.has(path)) continue;
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : readFileSync(target);
  const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Unrecorded upstream change: ${path}`);
  if ((mode === "120000") !== stat.isSymbolicLink()) throw new Error(`Changed file kind: ${path}`);
  if (process.platform !== "win32" && mode === "100755" && !(stat.mode & 0o111))
    throw new Error(`Lost executable permission: ${path}`);
  checked++;
}
const localFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "third_party/solidcraft/"],
  { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
for (const file of localFiles.split("\0").filter(Boolean)) {
  const relative = file.slice("third_party/solidcraft/".length);
  if (!upstreamPaths.has(relative) && !patches.has(relative))
    throw new Error(`Unrecorded upstream addition: ${relative}`);
}
const metadata = cargoMetadataSchema.parse(
  JSON.parse(
    execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ),
);
const boundaryViolations = checkRustBoundaries(metadata, readRustBoundaryFeatures());
if (boundaryViolations.length) throw new Error(boundaryViolations.join("\n"));
const actualMembers = metadata.packages
  .filter((pkg) => metadata.workspace_members.includes(pkg.id))
  .map((pkg) => pkg.name)
  .sort();
const expectedMembers = [
  "madori-display",
  "madori-geometry",
  "madori-geometry-api",
  "madori-housing",
  "madori-modeling",
  "madori-viewer",
];
if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers))
  throw new Error(`Unexpected workspace members: ${actualMembers.join(", ")}`);
const dockerfile = readFileSync(new URL("apps/geometry/Dockerfile", repositoryRoot), "utf8");
if (
  !dockerfile.includes(`EXPOSE ${geometryInternal.port}`) ||
  !dockerfile.includes(`MADORI_GEOMETRY_BIND=0.0.0.0:${geometryInternal.port}`)
)
  throw new Error("Dockerfile must use the internal API port");

console.log(
  `Layout passed: ${checked} unchanged upstream files, ${patches.size} recorded patch files, ${actualMembers.length} service Rust crates.`,
);

assertStagingBindings(
  ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync(new URL("apps/worker/wrangler.jsonc", repositoryRoot), "utf8"),
  ).config,
);
