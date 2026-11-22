import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const options = { timeout: 120_000, maxBuffer: 32 * 1024 ** 2 };
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const containerId = z.string().regex(/^[a-f0-9]{64}$/u);
const devRepo = "cloudflare-dev/geometrycontainer-geometry-8788ff521eb5";
const stagingRepo =
  /^registry\.cloudflare\.com\/[a-f0-9]{32}\/instant-madori-staging-geometrycontainer-geometry$/u;
const imageSchema = z.object({
  Id: imageId,
  RepoTags: z
    .array(
      z
        .string()
        .regex(/^(?:[^\s@]+:[\w][\w.-]{0,127}|[^\s@]+@sha256:[a-f0-9]{64}|<none>:<none>)$/u),
    )
    .nullable(),
  Metadata: z.object({ LastTagTime: z.iso.datetime({ offset: true }).optional() }).optional(),
});

type Image = { id: string; references: string[]; lastTaggedAt: number | undefined };
type Decision = { id: string; kept: string[]; untagged: string[] } & (
  | { kind: "protected"; reason: "container" | "unknown-tag-time" | "session" }
  | { kind: "retained" }
  | { kind: "removed" }
);

export function parseImages(output: string): Image[] {
  const rows = z.array(imageSchema).parse(JSON.parse(output));
  if (new Set(rows.map((row) => row.Id)).size !== rows.length) {
    throw new Error("Inconsistent Docker image inventory");
  }
  const images: Image[] = [];
  for (const row of rows) {
    const references = (row.RepoTags ?? [])
      .filter((ref) => {
        const repo = ref.slice(0, ref.lastIndexOf(":"));
        return repo === devRepo || stagingRepo.test(repo);
      })
      .sort();
    if (references.length === 0) continue;
    const time = row.Metadata?.LastTagTime;
    images.push({
      id: row.Id,
      references,
      lastTaggedAt: time && !time.startsWith("0001-") ? Date.parse(time) : undefined,
    });
  }
  const refs = images.flatMap((image) => image.references);
  if (new Set(refs).size !== refs.length) throw new Error("Duplicate Docker image reference");
  return images;
}

export function planImageRetention(input: {
  images: readonly Image[];
  containerImageIds: ReadonlySet<string>;
  sessionsSince: number | undefined;
  keep: number;
}): Decision[] {
  return [...input.images]
    .sort(
      (a, b) =>
        (b.lastTaggedAt ?? Infinity) - (a.lastTaggedAt ?? Infinity) || a.id.localeCompare(b.id),
    )
    .map(({ id, references, lastTaggedAt }, index) => {
      const reason = input.containerImageIds.has(id)
        ? "container"
        : lastTaggedAt === undefined
          ? "unknown-tag-time"
          : input.sessionsSince !== undefined && lastTaggedAt >= input.sessionsSince
            ? "session"
            : undefined;
      if (reason) return { id, kind: "protected", reason, kept: references, untagged: [] };
      if (index < input.keep)
        return {
          id,
          kind: "retained",
          kept: references.slice(0, 1),
          untagged: references.slice(1),
        };
      return { id, kind: "removed", kept: [], untagged: references };
    });
}

function lines(output: string) {
  const trimmed = output.trim();
  return trimmed ? trimmed.split(/\r?\n/u) : [];
}

const processLine = /^\s*(?:(?:(\d+)-)?([01]\d|2[0-3]):)?([0-5]\d):([0-5]\d)\s+(.+)$/u;
export function parseSessionsSince(output: string, now: number) {
  let oldest: number | undefined;
  const processes = z.array(z.string().regex(processLine)).min(1).parse(lines(output));
  for (const line of processes) {
    const match = processLine.exec(line);
    if (!match?.[5]?.includes("wrangler-dist/cli.js")) continue;
    const elapsed =
      ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3])) * 60 +
      Number(match[4]);
    // Docker Desktop's VM clock can lag behind the host clock used by ps.
    const since = now - elapsed * 1000 - 5 * 60_000;
    oldest = oldest === undefined ? since : Math.min(oldest, since);
  }
  return oldest;
}

async function docker(...args: string[]) {
  return (await exec("docker", args, options)).stdout;
}

const vanished = /^Error response from daemon: No such (?:image|container): /u;
const refused = /^Error response from daemon: (?:conflict: unable to delete\b|No such image: )/u;

export function parseToleratedErrors(stderr: string, tolerated: RegExp) {
  return z.array(z.string().regex(tolerated)).min(1).parse(lines(stderr));
}

// Other sessions add and remove images and containers between our calls; Docker still
// prints the objects it found and names each missing one on stderr.
async function dockerTolerating(tolerated: RegExp, ...args: string[]) {
  try {
    return { stdout: await docker(...args), errors: [] };
  } catch (error) {
    const failure = z
      .object({ code: z.int().positive(), stdout: z.string(), stderr: z.string() })
      .safeParse(error);
    if (!failure.success) throw error;
    return {
      stdout: failure.data.stdout,
      errors: parseToleratedErrors(failure.data.stderr, tolerated),
    };
  }
}

async function inventory() {
  const ids = [
    ...new Set(z.array(imageId).parse(lines(await docker("image", "ls", "-q", "--no-trunc")))),
  ];
  return ids.length
    ? parseImages((await dockerTolerating(vanished, "image", "inspect", ...ids)).stdout)
    : [];
}

async function containerImages() {
  const ids = z
    .array(containerId)
    .parse(lines(await docker("container", "ls", "-a", "-q", "--no-trunc")));
  if (!ids.length) return new Set<string>();
  const { stdout } = await dockerTolerating(
    vanished,
    "container",
    "inspect",
    "--format",
    "{{json .Image}}",
    ...ids,
  );
  return new Set(z.array(imageId).parse(lines(stdout).map((line) => JSON.parse(line) as unknown)));
}

function summary(images: readonly Image[]) {
  return {
    images: images.length,
    references: images.reduce((sum, image) => sum + image.references.length, 0),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      keep: { type: "string", default: "3" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.info(
      "Usage: pnpm docker:prune-images [--dry-run] [--keep N]\nKeep one tag on each of the newest N images (default 3) and all tags on protected images.",
    );
    return;
  }
  const keep = z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.int().positive())
    .parse(values.keep);
  const images = await inventory();
  const containerImageIds = await containerImages();
  const now = Date.now();
  const sessionsSince = parseSessionsSince(
    (await exec("ps", ["-axo", "etime=,command="], options)).stdout,
    now,
  );
  const decisions = planImageRetention({ images, containerImageIds, sessionsSince, keep });
  console.info(
    JSON.stringify({
      event: "docker.images.prune.plan",
      dryRun: values["dry-run"],
      keep,
      sessionsSince: sessionsSince === undefined ? null : new Date(sessionsSince).toISOString(),
      before: summary(images),
      decisions,
    }),
  );
  if (values["dry-run"]) return;
  const refs = decisions.flatMap((decision) => decision.untagged);
  const conflicts = refs.length
    ? (await dockerTolerating(refused, "image", "rm", ...refs)).errors
    : [];
  console.info(
    JSON.stringify({
      event: "docker.images.prune.result",
      conflicts,
      after: summary(await inventory()),
    }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof z.ZodError
        ? "Invalid image pruning input or Docker output"
        : error instanceof Error
          ? error.message
          : "Docker image pruning failed",
    );
    process.exitCode = 1;
  }
}
