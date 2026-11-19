import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { jobWorkflowDeps } from "../compose.ts";
import { describeError, logEvent } from "../log.ts";
import { systemRuntime } from "../runtime.ts";
import { jobReferenceSchema, runJob } from "../services/jobs.ts";
import type { JobEnd, JobExecutionReference, JobSteps } from "../services/jobs.ts";

export class JobWorkflow extends WorkflowEntrypoint<Env, JobExecutionReference> {
  override async run(
    event: Readonly<WorkflowEvent<JobExecutionReference>>,
    step: WorkflowStep,
  ): Promise<JobEnd> {
    const job = jobReferenceSchema.parse(event.payload);
    const ids = {
      traceId: job.jobId,
      jobId: job.jobId,
      patternId: job.patternId,
      generation: job.generation,
    };
    const steps: JobSteps = {
      do: (name, config, body) =>
        step.do(name, config, async ({ attempt }) => {
          try {
            const result = await body();
            logEvent("info", "job.step", {
              ...ids,
              step: name,
              attempt,
              outcome: result.kind,
              ...("reason" in result && typeof result.reason === "string"
                ? { reason: result.reason }
                : {}),
              ...("revisionId" in result && typeof result.revisionId === "string"
                ? { revisionId: result.revisionId }
                : {}),
            });
            return result;
          } catch (error) {
            logEvent("error", "job.step", {
              ...ids,
              step: name,
              attempt,
              outcome: "error",
              error: describeError(error),
            });
            throw error;
          }
        }),
    };
    const end = await runJob(jobWorkflowDeps(this.env, systemRuntime), job, steps);
    logEvent(end.kind === "committed" ? "info" : "error", "job.finished", {
      ...ids,
      outcome: end.kind,
      ...(end.kind === "committed" ? { revisionId: end.revisionId } : { reason: end.reason }),
    });
    return end;
  }
}
