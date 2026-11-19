import type { JobExecutionReference, JobRuns } from "../services/jobs.ts";

const instanceExists = 10405;

export function jobInstanceId(job: JobExecutionReference): string {
  return `job-${job.jobId}-g${job.generation}`;
}

export function jobRuns(workflow: Pick<Workflow<JobExecutionReference>, "createBatch">): JobRuns {
  return {
    async start(job) {
      const id = jobInstanceId(job);
      const { created, errors } = await workflow.createBatch({
        instances: [
          {
            id,
            params: { patternId: job.patternId, jobId: job.jobId, generation: job.generation },
          },
        ],
      });
      if (created.length === 1) return "created";
      if (errors[0]?.code === instanceExists) return "existing";
      throw new Error(`Job run ${id} was not started: ${errors[0]?.code} ${errors[0]?.message}`);
    },
  };
}
