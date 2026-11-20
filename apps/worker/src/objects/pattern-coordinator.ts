import { DurableObject } from "cloudflare:workers";
import { patternCoordinatorDeps, stalledPatternSweepDeps } from "../compose.ts";
import { describeError, logEvent } from "../log.ts";
import type { LogFields } from "../log.ts";
import { systemRuntime } from "../runtime.ts";
import { runAlarmCycle } from "./alarm-cycle.ts";
import {
  reconcilePattern,
  keepsWatching,
  sweepStalledPatterns as sweep,
  jobReferenceSchema,
} from "../services/jobs.ts";

const logOutcome = {
  claimed: { level: "info", fields: { outcome: "claimed", instance: "created" } },
  run_restarted: { level: "info", fields: { outcome: "running", instance: "created" } },
  running: { level: "info", fields: { outcome: "running", instance: "existing" } },
  stalled: { level: "error", fields: { outcome: "stalled" } },
  failed_lost_run: { level: "error", fields: { outcome: "failed" } },
  settled_meanwhile: { level: "info", fields: { outcome: "not_running" } },
  queue_held: { level: "info", fields: { outcome: "queue_held" } },
  idle: { level: "info", fields: { outcome: "idle" } },
} as const satisfies Record<
  Awaited<ReturnType<typeof reconcilePattern>>["kind"],
  { level: "info" | "error"; fields: LogFields }
>;

export class PatternCoordinator extends DurableObject<Env> {
  async wake(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const named = jobReferenceSchema.shape.patternId.safeParse(this.ctx.id.name);
    if (!named.success) {
      logEvent("error", "pattern.unknown", {});
      return;
    }
    const patternId = named.data;
    await runAlarmCycle({
      storage: this.ctx.storage,
      now: Date.now,
      reconcile: async () => {
        const result = await reconcilePattern(
          patternCoordinatorDeps(this.env, this.ctx.exports.JobWorkflow, systemRuntime),
          { patternId },
        );
        const { level, fields } = logOutcome[result.kind];
        logEvent(level, "pattern.advanced", {
          patternId,
          ...fields,
          ...("job" in result ? { ...result.job, traceId: result.job.jobId } : {}),
          ...("instanceStatus" in result ? { instanceStatus: result.instanceStatus } : {}),
          ...("heldBy" in result ? { heldBy: result.heldBy } : {}),
        });
        return keepsWatching(result);
      },
      failed: (error) =>
        logEvent("error", "pattern.advance_failed", { patternId, error: describeError(error) }),
    });
  }
}

export async function sweepStalledPatterns(env: Env) {
  const result = await sweep(stalledPatternSweepDeps(env, systemRuntime));
  if (result.found > 0)
    logEvent(result.wakeFailed ? "error" : "info", "jobs.swept", {
      ...result,
      truncated: Number(result.truncated),
    });
}
