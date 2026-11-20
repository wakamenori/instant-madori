import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const accountId = "4a67230af28ec94d9c70ca48572d8e9f";
const scriptName = "instant-madori-staging";
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const repositoryPattern = "[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*";
const imageRefSchema = z
  .string()
  .regex(
    new RegExp(
      `^registry\\.cloudflare\\.com/${accountId}/${repositoryPattern}@sha256:[a-f0-9]{64}$`,
      "u",
    ),
  );
const tagSchema = z.object({
  tag: z.string().regex(new RegExp(`^${repositoryPattern}:[\\w][\\w.-]{0,127}$`, "u")),
  digest: digestSchema.nullable(),
});
const versionSchema = z.object({
  id: z.uuid(),
  createdOn: z.iso.datetime({ offset: true }),
  imageRefs: z.array(imageRefSchema),
});
type Version = z.infer<typeof versionSchema>;
type Tag = z.infer<typeof tagSchema>;
type RetentionPlan =
  | { kind: "ready"; repository: string; keep: Tag[]; remove: Tag[]; unreferenced: Tag[] }
  | { kind: "blocked"; reason: string; remove: [] };

function imageParts(ref: string) {
  const [repository = "", digest = ""] = ref
    .slice(`registry.cloudflare.com/${accountId}/`.length)
    .split("@");
  return { repository, digest };
}

export function selectTags(input: {
  versions: Version[];
  currentIds: ReadonlySet<string>;
  tags: Tag[];
  retain: number;
}): RetentionPlan {
  const parsed = z
    .object({
      versions: z.array(versionSchema).min(1),
      tags: z.array(tagSchema),
      retain: z.number().int().positive(),
    })
    .safeParse(input);
  const blocked = (reason: string): RetentionPlan => ({ kind: "blocked", reason, remove: [] });
  if (!parsed.success)
    return blocked("Invalid versions, image references, tags or retention count");
  const { versions, tags, retain } = parsed.data;
  const ids = new Set(versions.map(({ id }) => id));
  if (
    ids.size !== versions.length ||
    input.currentIds.size === 0 ||
    [...input.currentIds].some((id) => !ids.has(id))
  ) {
    return blocked("Version IDs must be unique and include every current deployment version");
  }
  if (
    versions.some(
      (v, i) => i > 0 && Date.parse(v.createdOn) > Date.parse(versions[i - 1]?.createdOn ?? ""),
    )
  ) {
    return blocked("Versions must be newest first");
  }
  if (
    new Set(tags.map(({ tag }) => tag)).size !== tags.length ||
    tags.some(({ digest }) => digest === null)
  ) {
    return blocked("Every tag must have one readable digest");
  }
  const retained = versions.filter((v, i) => i < retain || input.currentIds.has(v.id));
  const repositories = new Set(
    retained.flatMap(({ imageRefs }) => imageRefs.map((ref) => imageParts(ref).repository)),
  );
  const [repository] = repositories;
  if (repositories.size !== 1 || !repository)
    return blocked("Retained versions must reference exactly one repository");
  const digests = (items: Version[]) =>
    new Set(
      items.flatMap(({ imageRefs }) =>
        imageRefs
          .map(imageParts)
          .filter((ref) => ref.repository === repository)
          .map(({ digest }) => digest),
      ),
    );
  const protectedDigests = digests(retained);
  const knownDigests = digests(versions);
  const keep: Tag[] = [];
  const remove: Tag[] = [];
  const unreferenced: Tag[] = [];
  for (const tag of tags) {
    if (tag.tag.slice(0, tag.tag.lastIndexOf(":")) !== repository) continue;
    if (tag.digest !== null && protectedDigests.has(tag.digest)) keep.push(tag);
    else if (tag.digest !== null && knownDigests.has(tag.digest)) remove.push(tag);
    else unreferenced.push(tag);
  }
  return { kind: "ready", repository, keep, remove, unreferenced };
}

const versionSummarySchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  metadata: z.object({ created_on: z.iso.datetime({ offset: true }) }),
});
const versionsPageSchema = z.object({
  success: z.literal(true),
  result: z.object({ items: z.array(versionSummarySchema) }),
  result_info: z.object({
    page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    count: z.number().int().nonnegative(),
    total_count: z.number().int().positive(),
  }),
});
const versionDetailSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.uuid(),
    resources: z.object({
      script_runtime: z.object({
        containers: z.array(z.object({ images: z.record(z.string(), imageRefSchema) })),
      }),
    }),
  }),
});
const deploymentsSchema = z.object({
  success: z.literal(true),
  result: z.object({
    deployments: z
      .array(
        z.object({
          id: z.uuid(),
          versions: z.array(z.object({ version_id: z.uuid() })).min(1),
        }),
      )
      .min(1),
  }),
});
const catalogSchema = z.array(
  z.object({ name: z.string().min(1), tags: z.array(z.string().min(1)) }),
);
const registryCredentialsSchema = z.object({
  account_id: z.literal(accountId),
  registry_host: z.literal("registry.cloudflare.com"),
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function collectVersions(json: (path: string) => Promise<unknown>) {
  const summaries: z.infer<typeof versionSummarySchema>[] = [];
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const data = versionsPageSchema.parse(await json(`/versions?page=${page}&per_page=10`));
    const info = data.result_info;
    total ??= info.total_count;
    if (
      info.page !== page ||
      info.per_page !== 10 ||
      info.total_count !== total ||
      info.count !== data.result.items.length ||
      info.count !== Math.min(10, total - summaries.length)
    ) {
      throw new Error("Incomplete or changing version pagination");
    }
    summaries.push(...data.result.items);
    if (summaries.length >= total) break;
  }
  if (
    summaries.length !== total ||
    new Set(summaries.map(({ id }) => id)).size !== total ||
    summaries.some((item, i) => i > 0 && item.number >= (summaries[i - 1]?.number ?? 0))
  ) {
    throw new Error("Version pagination has missing, repeated or unordered entries");
  }
  const versions: Version[] = [];
  for (const summary of summaries) {
    const detail = versionDetailSchema.parse(await json(`/versions/${summary.id}`)).result;
    if (detail.id !== summary.id) throw new Error("Version detail ID mismatch");
    versions.push({
      id: summary.id,
      createdOn: summary.metadata.created_on,
      imageRefs: detail.resources.script_runtime.containers.flatMap(({ images }) =>
        Object.values(images),
      ),
    });
  }
  return versions;
}

const execute = promisify(execFile);
async function wrangler(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "madori-registry-"));
  try {
    const result = await execute(
      "pnpm",
      ["--filter", "@madori/worker", "exec", "wrangler", ...args],
      {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (result.stderr.includes("garbage-collection request failed")) {
      console.error("Wrangler deleted the tag, but its garbage-collection request failed");
    }
    return result.stdout;
  } catch {
    // Child output can contain credentials, so it must not appear in an exception.
    throw new Error(`Wrangler ${args.slice(0, 3).join(" ")} failed; output withheld`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function wranglerJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Invalid Wrangler JSON; output withheld");
  }
}

export async function runRetention(options: {
  apply: boolean;
  json: (path: string) => Promise<unknown>;
  command: (args: string[]) => Promise<string>;
  registryHead: (
    repository: string,
    tag: string,
    credentials: z.infer<typeof registryCredentialsSchema>,
  ) => Promise<string | null>;
  log: (message: string) => void;
}) {
  const versions = await collectVersions(options.json);
  const deployment = deploymentsSchema.parse(await options.json("/deployments")).result
    .deployments[0];
  if (!deployment) throw new Error("Current deployment is missing");
  const currentIds = new Set(deployment.versions.map(({ version_id }) => version_id));
  const scope = selectTags({ versions, currentIds, tags: [], retain: 10 });
  if (scope.kind === "blocked") throw new Error(scope.reason);
  const catalog = catalogSchema.parse(
    wranglerJson(await options.command(["containers", "images", "list", "--json"])),
  );
  const entries = catalog.filter(({ name }) => name === scope.repository);
  if (entries.length !== 1)
    throw new Error("Target repository must appear exactly once in the registry catalog");
  const credentials = registryCredentialsSchema.parse(
    wranglerJson(
      await options.command([
        "containers",
        "registries",
        "credentials",
        "registry.cloudflare.com",
        "--pull",
        "--json",
      ]),
    ),
  );
  if (process.env.GITHUB_ACTIONS === "true") options.log(`::add-mask::${credentials.password}`);
  const tags: Tag[] = [];
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const parsedTag = tagSchema.parse({ tag: `${entry.name}:${tag}`, digest: null });
      const digest = digestSchema.parse(await options.registryHead(entry.name, tag, credentials));
      tags.push({ ...parsedTag, digest });
    }
  }
  const plan = selectTags({ versions, currentIds, tags, retain: 10 });
  if (plan.kind === "blocked") throw new Error(plan.reason);
  const current = deploymentsSchema.parse(await options.json("/deployments")).result.deployments[0];
  const newest = versionsPageSchema.parse(await options.json("/versions?page=1&per_page=10")).result
    .items[0];
  if (current?.id !== deployment.id || newest?.id !== versions[0]?.id)
    throw new Error("Deployment or versions changed during collection");
  options.log(
    JSON.stringify({
      mode: options.apply ? "apply" : "dry-run",
      versions: versions.length,
      retainedVersionIds: versions
        .filter((v, i) => i < 10 || currentIds.has(v.id))
        .map(({ id }) => id),
      otherRepositories: catalog.filter(({ name }) => name !== plan.repository),
      ...plan,
    }),
  );
  if (options.apply) {
    for (const tag of plan.remove) {
      await options.command(["containers", "images", "delete", tag.tag, "--skip-confirmation"]);
      options.log(JSON.stringify({ deleted: tag.tag, digest: tag.digest }));
    }
  }
  return plan;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply" && args[0] !== "--dry-run")) {
    throw new Error("Usage: node scripts/deploy/registry-retention.ts [--dry-run|--apply]");
  }
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN must not be empty");
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== accountId) {
    throw new Error("Registry retention is restricted to the staging account");
  }
  await runRetention({
    apply: args[0] === "--apply",
    async json(path) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}${path}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) throw new Error(`Workers API ${path} failed (${response.status})`);
      return response.json();
    },
    command: wrangler,
    async registryHead(repository, tag, credentials) {
      const response = await fetch(
        `https://registry.cloudflare.com/v2/${accountId}/${repository}/manifests/${tag}`,
        {
          method: "HEAD",
          headers: {
            authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
            accept:
              "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) throw new Error(`Registry HEAD failed (${response.status})`);
      return response.headers.get("Docker-Content-Digest");
    },
    log: console.log,
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof z.ZodError
        ? "Invalid Cloudflare response; no tags deleted"
        : error instanceof Error
          ? error.message
          : "Registry retention failed",
    );
    process.exitCode = 1;
  }
}
