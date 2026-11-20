import type { JobExecutionReference, JobRuns } from "../services/jobs.ts";

const classification = {
  queued: "progressing",
  running: "progressing",
  waiting: "progressing",
  rollingBack: "progressing",
  paused: "stalled",
  waitingForPause: "stalled",
  unknown: "stalled",
  errored: "ended",
  terminated: "ended",
  complete: "ended",
} as const satisfies Record<InstanceStatus["status"], "progressing" | "stalled" | "ended">;

const instanceExists = 10405;

export function jobInstanceId(job: JobExecutionReference): string {
  return `job-${job.jobId}-g${job.generation}`;
}

export function jobRuns(
  workflow: Pick<Workflow<JobExecutionReference>, "createBatch" | "get">,
): JobRuns {
  return {
    async observe(job) {
      const id = jobInstanceId(job);
      const { created, errors } = await workflow.createBatch({
        instances: [
          {
            id,
            params: { patternId: job.patternId, jobId: job.jobId, generation: job.generation },
          },
        ],
      });
      if (created.length === 1) return { kind: "started" };
      if (errors[0]?.code === instanceExists) {
        try {
          const instance = await workflow.get(id);
          const { status } = await instance.status();
          return {
            kind: Object.hasOwn(classification, status) ? classification[status] : "stalled",
            instanceStatus: status,
          };
        } catch {
          return { kind: "stalled", instanceStatus: "unreadable" };
        }
      }
      throw new Error(`Job run ${id} was not started: ${errors[0]?.code} ${errors[0]?.message}`);
    },
  };
}
