import { execFile } from "node:child_process";
import { get } from "node:http";
import { text } from "node:stream/consumers";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const defaultMountLimitBytes = 8 * 1024 ** 3;
const timestamp = z.iso.datetime({ offset: true });
const recordSchema = z
  .object({
    ID: z.string().regex(/^[a-z0-9]{1,128}$/u),
    Type: z.enum([
      "regular",
      "internal",
      "frontend",
      "source.local",
      "source.git.checkout",
      "exec.cachemount",
    ]),
    Size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    InUse: z.boolean(),
    CreatedAt: timestamp,
    LastUsedAt: timestamp.nullish(),
  })
  .transform((record) => ({
    id: record.ID,
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
  if (new Set(records.map(({ id }) => id)).size !== records.length) {
    throw new Error("Duplicate Docker cache IDs; no cache pruned");
  }
  return records;
}

export function selectBuildCache(input: {
  records: readonly CacheRecord[];
  mountLimitBytes: number;
}): CacheRecord[] {
  const mounts = input.records.filter(({ kind }) => kind === "exec.cachemount");
  let mountBytes = mounts.reduce((sum, record) => sum + record.sizeBytes, 0);
  const remove = input.records.filter(({ kind, inUse }) => kind !== "exec.cachemount" && !inUse);
  const unusedMounts = mounts
    .filter(({ inUse }) => !inUse)
    .sort((a, b) => a.usedAt - b.usedAt || a.id.localeCompare(b.id));
  for (const mount of unusedMounts) {
    if (mountBytes <= input.mountLimitBytes) break;
    remove.push(mount);
    mountBytes -= mount.sizeBytes;
  }
  return remove;
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

function summary(records: CacheRecord[]) {
  return {
    records: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.sizeBytes, 0),
    cacheMountBytes: records
      .filter(({ kind }) => kind === "exec.cachemount")
      .reduce((sum, record) => sum + record.sizeBytes, 0),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "mount-limit-bytes": { type: "string", default: String(defaultMountLimitBytes) },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.info(
      "Usage: pnpm docker:prune-build-cache [--dry-run] [--mount-limit-bytes N]\n" +
        "Remove unused build cache; retain up to 8 GiB of cache mounts by default.",
    );
    return;
  }
  const mountLimitBytes = z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
    .parse(values["mount-limit-bytes"]);
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
  const remove = selectBuildCache({ records, mountLimitBytes });
  console.info(
    JSON.stringify({
      event: "docker.cache.prune.plan",
      dryRun: values["dry-run"],
      mountLimitBytes,
      before: summary(records),
      remove,
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
  console.info(
    JSON.stringify({
      event: "docker.cache.prune.result",
      mountLimitBytes,
      after: summary(await inventory(socketPath)),
    }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof z.ZodError
        ? "Invalid Docker cache inventory, local Unix socket or mount limit; no further cache pruned"
        : error instanceof Error
          ? error.message
          : "Docker cache pruning failed",
    );
    process.exitCode = 1;
  }
}
