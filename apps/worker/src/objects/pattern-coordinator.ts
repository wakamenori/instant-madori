import { DurableObject } from "cloudflare:workers";
import { patternCoordinatorDeps } from "../compose.ts";
import { describeError, logEvent } from "../log.ts";
import { systemRuntime } from "../runtime.ts";
import { advancePattern, jobReferenceSchema } from "../services/jobs.ts";

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
    try {
      const advance = await advancePattern(
        patternCoordinatorDeps(this.env, this.ctx.exports.JobWorkflow, systemRuntime),
        { patternId },
      );
      logEvent("info", "pattern.advanced", {
        patternId,
        outcome: advance.kind,
        ...(advance.kind === "idle"
          ? {}
          : {
              traceId: advance.job.jobId,
              jobId: advance.job.jobId,
              generation: advance.job.generation,
              instance: advance.instance,
            }),
      });
    } catch (error) {
      logEvent("error", "pattern.advance_failed", { patternId, error: describeError(error) });
      throw error;
    }
  }
}
