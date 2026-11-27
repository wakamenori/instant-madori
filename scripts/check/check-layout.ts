import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

const upstreamCacheSchema = z.record(
  z.string(),
  z.object({
    stat: z.string().regex(/^\d+:\d+:\d+:-?\d+:-?\d+$/),
    oid: z.string().regex(/^[a-f0-9]{40}$/),
  }),
);

function readUpstreamCache(cachePath: string): ReadonlyMap<string, { stat: string; oid: string }> {
  try {
    const cache = upstreamCacheSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf8")));
    if (cache.success) return new Map(Object.entries(cache.data));
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    )
      throw error;
  }
  return new Map();
}

export function checkUpstream(
  root: URL,
  pin: Pick<ReturnType<typeof readUpstreamPin>, "commit" | "localPatches">,
  cachePath: string,
): number {
  // Recent timestamps may share a filesystem clock tick with a write during the scan.
  const stableBefore = BigInt(Date.now() - 2000) * 1_000_000n;
  const previous = readUpstreamCache(cachePath);
  const updated = new Map<string, { stat: string; oid: string }>();
  const cwd = fileURLToPath(root);
  const tree = execFileSync("git", ["ls-tree", "-rz", pin.commit], {
    cwd,
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
    const target = upstreamFilePath(root, path);
    const stat = lstatSync(target, { bigint: true });
    if (patches.has(path)) continue;
    const statKey = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = previous.get(path);
    let actual: string;
    if (cached?.stat === statKey) {
      actual = cached.oid;
    } else {
      const bytes = stat.isSymbolicLink()
        ? readlinkSync(target, { encoding: "buffer" })
        : readFileSync(target);
      actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    }
    if (actual !== expected) throw new Error(`Unrecorded upstream change: ${path}`);
    if ((mode === "120000") !== stat.isSymbolicLink())
      throw new Error(`Changed file kind: ${path}`);
    if (process.platform !== "win32" && mode === "100755" && !(stat.mode & 0o111n))
      throw new Error(`Lost executable permission: ${path}`);
    if (stat.mtimeNs <= stableBefore && stat.ctimeNs <= stableBefore)
      updated.set(path, { stat: statKey, oid: actual });
    checked++;
  }
  const localFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "third_party/solidcraft/"],
    { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  for (const file of localFiles.split("\0").filter(Boolean)) {
    const relative = file.slice("third_party/solidcraft/".length);
    if (!upstreamPaths.has(relative) && !patches.has(relative))
      throw new Error(`Unrecorded upstream addition: ${relative}`);
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(updated)));
    renameSync(temporary, cachePath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return checked;
}

if (import.meta.main) {
  // Overlaps cargo with the upstream scan. A second concurrent cargo would wait on its package cache lock.
  const cargoMetadata = promisify(execFile)(
    "cargo",
    ["metadata", "--locked", "--format-version", "1"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const workerLayerViolations = checkWorkerLayers(
    readdirSync(new URL("apps/worker/src/", repositoryRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  if (workerLayerViolations.length) throw new Error(workerLayerViolations.join("\n"));

  const pin = readUpstreamPin();
  const checked = checkUpstream(
    repositoryRoot,
    pin,
    fileURLToPath(new URL("node_modules/.cache/madori-check/upstream-blobs.json", repositoryRoot)),
  );
  const metadata = cargoMetadataSchema.parse(JSON.parse((await cargoMetadata).stdout));
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
    `Layout passed: ${checked} unchanged upstream files, ${new Set(pin.localPatches).size} recorded patch files, ${actualMembers.length} service Rust crates.`,
  );

  assertStagingBindings(
    ts.parseConfigFileTextToJson(
      "wrangler.jsonc",
      readFileSync(new URL("apps/worker/wrangler.jsonc", repositoryRoot), "utf8"),
    ).config,
  );
}
