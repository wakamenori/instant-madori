import ts from "typescript";
import { z } from "zod";
const workflow = "deploy-staging.yml";
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const refSchema = z.object({ object: z.object({ sha: shaSchema }) });
const stagingSchema = z.object({
  env: z.object({
    staging: z.object({
      vars: z.object({
        GEOMETRY_INSTANCE_TYPE: z.string().min(1),
        GEOMETRY_IDLE_TIMEOUT_MS: z.coerce.number().int().positive(),
      }),
    }),
  }),
});
const run = z.object({
  databaseId: z.number().int().positive(),
  headSha: shaSchema,
  headBranch: z.string(),
  event: z.string(),
  status: z.enum(["requested", "queued", "pending", "waiting", "in_progress", "completed"]),
  conclusion: z.string(),
  createdAt: z.iso.datetime(),
  url: z.url(),
});
const runs = z.array(run);
const view = run
  .pick({ status: true, conclusion: true, headSha: true, url: true })
  .extend({ startedAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
type DeployDeps = {
  gh: (args: readonly string[]) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  report: (line: string) => void;
};
type DeployRequest = { ref: string; instance: string };

export async function deployStaging(
  { ref, instance }: DeployRequest,
  { gh, now, sleep, report }: DeployDeps,
) {
  async function ghJson<T>(args: string[], schema: z.ZodType<T>) {
    const output = await gh(args);
    try {
      return schema.parse(JSON.parse(output));
    } catch {
      throw new Error(`Invalid gh JSON for ${args[0]} ${args[1]}`);
    }
  }
  const branchPath = ref.split("/").map(encodeURIComponent).join("/");
  const {
    object: { sha },
  } = await ghJson(["api", `repos/{owner}/{repo}/git/ref/heads/${branchPath}`], refSchema);
  const contents = await gh([
    "api",
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/{owner}/{repo}/contents/apps/worker/wrangler.jsonc?ref=${sha}`,
  ]);
  const config = ts.parseConfigFileTextToJson("wrangler.jsonc", contents);
  const staging = stagingSchema.safeParse(config.config);
  if (config.error || !staging.success) throw new Error("Invalid staging wrangler.jsonc");
  const { GEOMETRY_INSTANCE_TYPE: instanceType, GEOMETRY_IDLE_TIMEOUT_MS: idleTimeoutMs } =
    staging.data.env.staging.vars;
  if (instanceType !== instance)
    throw new Error(
      `origin/${ref} at ${sha.slice(0, 7)} sets ${instanceType}, not ${instance}. Commit and push the change first.`,
    );
  const list = () =>
    ghJson(
      [
        "run",
        "list",
        "--workflow",
        workflow,
        "--limit",
        "50",
        "--json",
        Object.keys(run.shape).join(","),
      ],
      runs,
    );
  const snapshot = await list();
  const pending = snapshot.find((r) => r.status === "pending");
  if (pending) throw new Error(`deploy ${pending.url} is pending. A dispatch would replace it.`);
  const before = new Set(snapshot.map((r) => r.databaseId));
  await gh(["workflow", "run", workflow, "--ref", ref]);
  const discoveryDeadline = now() + 120_000;
  let candidate: z.infer<typeof run> | undefined;
  while (now() < discoveryDeadline) {
    const candidates = (await list()).filter(
      (r) => !before.has(r.databaseId) && r.event === "workflow_dispatch" && r.headBranch === ref,
    );
    if (candidates.length > 1)
      throw new Error(`ambiguous deploy runs: ${candidates.map((r) => r.url).join(", ")}`);
    candidate = candidates[0];
    if (candidate) break;
    await sleep(5000);
  }
  if (!candidate) throw new Error("the dispatched run did not appear in 2 min");
  if (candidate.headSha !== sha) throw new Error(`${ref} moved after the check`);
  const deadline = now() + 3 * 3600_000;
  let previous: string | undefined;
  while (now() < deadline) {
    const result = await ghJson(
      ["run", "view", String(candidate.databaseId), "--json", Object.keys(view.shape).join(",")],
      view,
    );
    if (result.headSha !== sha) throw new Error(`${ref} moved after the check`);
    if (result.status !== previous) report(`${result.url} ${result.status}`);
    previous = result.status;
    if (result.status === "completed") {
      if (result.conclusion === "cancelled")
        throw new Error(
          `run ${result.url} was cancelled. A newer staging deploy may have replaced it while pending.`,
        );
      if (result.conclusion !== "success")
        throw new Error(`run ${result.url} ended ${result.conclusion}`);
      return {
        ref,
        sha,
        instanceType,
        idleTimeoutMs,
        run: result.url,
        startedAt: result.startedAt,
        completedAt: result.updatedAt,
      };
    }
    await sleep(30_000);
  }
  throw new Error(`run ${candidate.url} did not complete within 3 h`);
}
