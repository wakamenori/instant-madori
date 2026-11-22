import { execFile } from "node:child_process";
import { get } from "node:http";
import { text } from "node:stream/consumers";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const defaultMountLimitBytes = 8 * 1024 ** 3;
const defaultLayerLimitBytes = 6 * 1024 ** 3;
const layerKinds = new Set(["regular", "frontend"]);
const discardedKinds = new Set(["internal", "source.local", "source.git.checkout"]);
const byteLimit = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const timestamp = z.iso.datetime({ offset: true });
const cacheId = z.string().regex(/^[a-z0-9]{1,128}$/u);
const parentIds = z.array(cacheId).nullish();
const recordSchema = z
  .object({
    ID: cacheId,
    // Docker Engine 29's JSON tag includes a leading space.
    " Parents": parentIds,
    Parents: parentIds,
    Type: z.string().min(1),
    Size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    InUse: z.boolean(),
    CreatedAt: timestamp,
    LastUsedAt: timestamp.nullish(),
  })
  .transform((record) => ({
    id: record.ID,
    parents: [...new Set([...(record[" Parents"] ?? []), ...(record.Parents ?? [])])],
    kind: record.Type,
    sizeBytes: record.Size,
    inUse: record.InUse,
    usedAt: Date.parse(record.LastUsedAt ?? record.CreatedAt),
  }));
type CacheRecord = z.infer<typeof recordSchema>;

export function parseBuildCache(output: string): CacheRecord[] {
  const data: unknown = JSON.parse(output);
  const { BuildCache } = z.object({ BuildCache: z.array(recordSchema).nullable() }).parse(data);
  const records = BuildCache ?? [];
  const ids = new Set(records.map(({ id }) => id));
  if (ids.size !== records.length) {
    throw new Error("Duplicate Docker cache IDs; no cache pruned");
  }
  for (const record of records) record.parents = record.parents.filter((id) => ids.has(id));
  rankRecords(records);
  return records;
}

function rankRecords(records: readonly CacheRecord[]) {
  const nodes = new Map(
    records.map((record) => [
      record.id,
      {
        record,
        subtreeUsedAt: record.usedAt,
        height: 0,
        remainingChildren: 0,
      },
    ]),
  );
  for (const { parents } of records) {
    for (const id of parents) {
      const parent = nodes.get(id);
      if (parent) parent.remainingChildren++;
    }
  }
  const ready = [...nodes.values()].filter((node) => node.remainingChildren === 0);
  for (const child of ready) {
    for (const id of child.record.parents) {
      const parent = nodes.get(id);
      if (!parent) continue;
      parent.subtreeUsedAt = Math.max(parent.subtreeUsedAt, child.subtreeUsedAt);
      parent.height = Math.max(parent.height, child.height + 1);
      if (--parent.remainingChildren === 0) ready.push(parent);
    }
  }
  if (ready.length !== records.length)
    throw new Error("Cycle in Docker cache parents; no cache pruned");
  return ready;
}

type CacheLimits = { mountLimitBytes: number; layerLimitBytes: number };

function planBuildCache(records: readonly CacheRecord[], limits: CacheLimits) {
  const ranked = rankRecords(records).sort(
    (a, b) =>
      a.subtreeUsedAt - b.subtreeUsedAt ||
      a.height - b.height ||
      a.record.id.localeCompare(b.record.id),
  );
  let { cacheMountBytes, layerBytes } = summary(records);
  const keptParents = new Set<string>();
  const remove: (CacheRecord & { subtreeUsedAt: number })[] = [];
  const keep: (CacheRecord & { subtreeUsedAt: number })[] = [];
  for (const { record, subtreeUsedAt } of ranked) {
    const mount = record.kind === "exec.cachemount";
    const layer = layerKinds.has(record.kind);
    const wanted =
      discardedKinds.has(record.kind) ||
      (mount && cacheMountBytes > limits.mountLimitBytes) ||
      (layer && layerBytes > limits.layerLimitBytes);
    if (wanted && !record.inUse && !keptParents.has(record.id)) {
      remove.push({ ...record, subtreeUsedAt });
      if (mount) cacheMountBytes -= record.sizeBytes;
      if (layer) layerBytes -= record.sizeBytes;
    } else {
      keep.push({ ...record, subtreeUsedAt });
      for (const parent of record.parents) keptParents.add(parent);
    }
  }
  return { remove, keep };
}

export function selectBuildCache(
  input: { records: readonly CacheRecord[] } & CacheLimits,
): CacheRecord[] {
  return planBuildCache(input.records, input).remove;
}

async function inventory(socketPath: string) {
  const output = await new Promise<string>((resolve, reject) => {
    // API 1.51 provides byte counts and timestamps without the CLI's display rounding.
    const request = get(
      { socketPath, path: "/v1.51/system/df?type=build-cache", timeout: 30_000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Docker disk usage failed (${response.statusCode})`));
          return;
        }
        void text(response).then(resolve, reject);
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Docker disk usage timed out")));
  });
  return parseBuildCache(output);
}

function summary(records: readonly CacheRecord[]) {
  return {
    records: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.sizeBytes, 0),
    cacheMountBytes: records
      .filter(({ kind }) => kind === "exec.cachemount")
      .reduce((sum, record) => sum + record.sizeBytes, 0),
    layerBytes: records
      .filter(({ kind }) => layerKinds.has(kind))
      .reduce((sum, record) => sum + record.sizeBytes, 0),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "mount-limit-bytes": { type: "string", default: String(defaultMountLimitBytes) },
      "layer-limit-bytes": { type: "string", default: String(defaultLayerLimitBytes) },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.info(
      "Usage: pnpm docker:prune-build-cache [--dry-run] [--mount-limit-bytes N] [--layer-limit-bytes N]\n" +
        "Retain up to 8 GiB of cache mounts and 6 GiB of recent regular/frontend layers by default.",
    );
    return;
  }
  const mountLimitBytes = byteLimit.parse(values["mount-limit-bytes"]);
  const layerLimitBytes = byteLimit.parse(values["layer-limit-bytes"]);
  const configuredHost = process.env["DOCKER_CONTEXT"] ? undefined : process.env["DOCKER_HOST"];
  const host = z
    .string()
    .regex(/^unix:\/\/\/.+/u)
    .parse(
      configuredHost ??
        JSON.parse(
          (
            await exec(
              "docker",
              ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
              { timeout: 30_000 },
            )
          ).stdout,
        ),
    );
  const socketPath = host.slice("unix://".length);
  const records = await inventory(socketPath);
  const unknownKinds = [...new Set(records.map(({ kind }) => kind))]
    .filter(
      (kind) => kind !== "exec.cachemount" && !layerKinds.has(kind) && !discardedKinds.has(kind),
    )
    .sort();
  if (unknownKinds.length > 0) {
    console.info(
      JSON.stringify({ event: "docker.cache.prune.unknown", retainedKinds: unknownKinds }),
    );
  }
  const { remove, keep } = planBuildCache(records, { mountLimitBytes, layerLimitBytes });
  console.info(
    JSON.stringify({
      event: "docker.cache.prune.plan",
      dryRun: values["dry-run"],
      mountLimitBytes,
      layerLimitBytes,
      before: summary(records),
      remove,
      keep,
      expectedAfter: summary(keep),
    }),
  );
  if (values["dry-run"]) return;
  if (remove.length > 0) {
    const ids = remove.map(({ id }) => id);
    const { stdout } = await exec(
      "docker",
      [
        "--host",
        host,
        "buildx",
        "prune",
        "--builder",
        "default",
        "--all",
        "--force",
        "--filter",
        `id~=^(${ids.join("|")})$`,
      ],
      {
        env: { ...process.env, DOCKER_CONTEXT: "" },
        timeout: 120_000,
        maxBuffer: 16 * 1024 ** 2,
      },
    );
    console.info(stdout.trim());
  }
  const after = await inventory(socketPath);
  const remaining = new Set(after.map(({ id }) => id));
  console.info(
    JSON.stringify({
      event: "docker.cache.prune.result",
      mountLimitBytes,
      layerLimitBytes,
      after: summary(after),
      notRemoved: remove.map(({ id }) => id).filter((id) => remaining.has(id)),
    }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof z.ZodError
        ? "Invalid Docker cache inventory, local Unix socket or cache limit; no further cache pruned"
        : error instanceof Error
          ? error.message
          : "Docker cache pruning failed",
    );
    process.exitCode = 1;
  }
}
