import assert from "node:assert/strict";
import { z } from "zod";
export class JourneyFailure extends Error {}
const stepName = "Migrate and deploy";
const runSchema = z.object({
  status: z.string(),
  jobs: z.array(
    z.object({
      steps: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          startedAt: z.string().optional(),
          completedAt: z.string().optional(),
        }),
      ),
    }),
  ),
});
const adoptionSchema = runSchema.extend({
  databaseId: z.int(),
  event: z.literal("workflow_dispatch"),
  headBranch: z.literal("main"),
  url: z.url(),
});
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export function polling(clock: Clock) {
  return async function poll<T>(
    label: string,
    read: () => Promise<T>,
    ready: (item: T) => boolean,
    deadline: number,
    interval = 2000,
  ) {
    for (;;) {
      const item = await read();
      if (ready(item)) return item;
      const left = deadline - clock.now();
      if (left <= 0) throw new JourneyFailure("timed out waiting for " + label);
      await clock.sleep(Math.min(left, interval));
    }
  };
}
export async function adoptDeploy(
  deployRun: string,
  gh: (args: readonly string[]) => Promise<string>,
  clock: Clock,
) {
  const poll = polling(clock);
  const view = async (fields: string): Promise<unknown> =>
    JSON.parse(await gh(["run", "view", deployRun, "--json", fields]));
  const migrate = (run: z.infer<typeof runSchema>) =>
    run.jobs.flatMap((j) => j.steps).find((s) => s.name === stepName);
  const adopted = adoptionSchema.parse(await view("databaseId,event,headBranch,status,url,jobs"));
  const stepStatus = migrate(adopted)?.status;
  assert(
    String(adopted.databaseId) === deployRun &&
      adopted.status !== "completed" &&
      (!stepStatus || stepStatus === "pending" || stepStatus === "queued"),
    "adopted run already past start of Migrate and deploy",
  );
  const unfinished = await gh([
    "api",
    "--paginate",
    "repos/{owner}/{repo}/actions/workflows/deploy-staging.yml/runs?per_page=100",
    "--jq",
    '.workflow_runs[] | select(.status != "completed") | .id',
  ]);
  assert(
    unfinished.trim() === deployRun,
    "adopted run must be the only unfinished deploy-staging run",
  );
  return {
    async waitForWindow() {
      const deployState = async () => runSchema.parse(await view("status,jobs"));
      const run = await poll(
        stepName,
        deployState,
        (r) =>
          r.status === "completed" ||
          ["completed", "in_progress"].includes(migrate(r)?.status ?? ""),
        clock.now() + 1_800_000,
      );
      return run.status !== "completed" && migrate(run)?.status === "in_progress";
    },
    async waitForResult() {
      const finalSchema = runSchema.extend({ conclusion: z.string() });
      const run = await poll(
        "deploy conclusion",
        async () => finalSchema.parse(await view("status,jobs,conclusion")),
        (r) => r.status === "completed",
        clock.now() + 1_800_000,
        15_000,
      );
      const deployment = migrate(run);
      return {
        id: deployRun,
        url: adopted.url,
        startedAt: deployment?.startedAt,
        completedAt: deployment?.completedAt,
        conclusion: run.conclusion,
      };
    },
  };
}
