import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { z } from "zod";
import {
  acceptedJobSchema,
  acceptInstructionResponseSchema,
  createProjectResponseSchema,
  meResponseSchema,
  patternStateResponseSchema,
  revisionSchema,
  revisionListResponseSchema,
} from "@madori/contracts";
import { newUser, startLocalWorker } from "./support/local-worker.ts";
import { settleJobs } from "./support/settle-jobs.ts";

const execFileAsync = promisify(execFile);
await test(
  "Job Workflows through workerd with Containers disabled",
  { timeout: 120_000 },
  async (t) => {
    const worker = await startLocalWorker();
    t.after(() => worker.stop());
    const owner = newUser("workflow");
    const me = await worker.call("/api/me", { as: owner });
    const ownerId = meResponseSchema.parse(await me.json()).user.id;
    async function create() {
      const response = await worker.call("/api/projects", {
        method: "POST",
        as: owner,
        body: { requestId: crypto.randomUUID() },
      });
      assert.equal(response.status, 201);
      return createProjectResponseSchema.parse(await response.json()).pattern;
    }
    async function fixture(kind: "seed" | "rows" | "overlap", patternId: string): Promise<unknown> {
      return worker.withPausedWorker(async (state) => {
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            fileURLToPath(new URL("./rpc/job-workflow-fixture.ts", import.meta.url)),
            state,
            JSON.stringify({ kind, ownerId, patternId }),
          ],
          { timeout: 120_000, maxBuffer: 1024 * 1024 },
        );
        const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        return result;
      });
    }
    async function accept(patternId: string) {
      const response = await worker.call(`/api/patterns/${patternId}/messages`, {
        method: "POST",
        as: owner,
        body: { requestId: crypto.randomUUID(), body: "作って" },
      });
      assert.equal(response.status, 202);
      return acceptInstructionResponseSchema.parse(await response.json()).job;
    }
    const rowsSchema = z.array(
      z.object({
        jobId: z.uuid(),
        state: z.string(),
        generation: z.int(),
        holdsQueue: z.literal(0),
        updatedAt: z.iso.datetime(),
      }),
    );
    await t.test(
      "a job fails without retry and keeps the previous revision and history",
      async () => {
        const pattern = await create();
        const revisions = z.array(revisionSchema).parse(await fixture("seed", pattern.id));
        const a = await accept(pattern.id);
        assert.deepEqual(await settleJobs(worker, owner, pattern.id, [a.jobId]), {
          pattern,
          currentRevision: revisions[0],
          runningJob: null,
          queueHold: null,
          queuedJobs: [],
          lastFinishedJob: { ...a, state: "failed" },
        });
        const history = await worker.call(`/api/patterns/${pattern.id}/revisions`, { as: owner });
        assert.deepEqual(revisionListResponseSchema.parse(await history.json()), {
          revisions,
          nextCursor: null,
        });
        const steps = worker
          .logEntries()
          .filter((line) => line["jobId"] === a.jobId && line["event"] === "job.step");
        assert.deepEqual(
          steps.map((line) => ({
            step: line["step"],
            attempt: line["attempt"],
            outcome: line["outcome"],
            ...(line["reason"] ? { reason: line["reason"] } : {}),
          })),
          [
            {
              step: "render snapshot",
              attempt: 1,
              outcome: "not_committed",
              reason: "containers_disabled",
            },
            {
              step: "record failure",
              attempt: 1,
              outcome: "failed",
              reason: "containers_disabled",
            },
            { step: "wake pattern", attempt: 1, outcome: "woken" },
          ],
        );
        const finished = await worker.logLine(a.jobId, "job.finished");
        assert.equal(finished["outcome"], "failed");
        assert.equal(finished["reason"], "containers_disabled");
        const rows = rowsSchema.parse(await fixture("rows", pattern.id));
        const row = rows.at(-1);
        assert(row);
        assert.deepEqual(
          { jobId: row.jobId, state: row.state, generation: row.generation },
          { jobId: a.jobId, state: "failed", generation: 1 },
        );
      },
    );
    await t.test(
      "a queued job waits for the running job, and a wake starts the run a claim left behind",
      async () => {
        const pattern = await create();
        const [a, b] = z
          .array(acceptedJobSchema)
          .length(2)
          .parse(await fixture("overlap", pattern.id));
        assert(a && b);
        const response = await worker.call(`/api/patterns/${pattern.id}/state`, { as: owner });
        assert.deepEqual(patternStateResponseSchema.parse(await response.json()), {
          pattern,
          currentRevision: null,
          runningJob: a,
          queueHold: null,
          queuedJobs: [b],
          lastFinishedJob: null,
        });
        const c = await accept(pattern.id);
        for (const held of [a, b]) {
          await worker.logLine(held.jobId, "job.finished");
          const response = await worker.call(`/api/patterns/${pattern.id}/state`, { as: owner });
          const state = patternStateResponseSchema.parse(await response.json());
          assert.deepEqual(state.queueHold, { job: { ...held, state: "failed" } });
          const resume = await worker.call(`/api/patterns/${pattern.id}/queue/resume`, {
            method: "POST",
            as: owner,
            body: { heldBy: held.jobId, requestId: crypto.randomUUID() },
          });
          assert.equal(resume.status, 200);
        }
        assert.equal(
          (await settleJobs(worker, owner, pattern.id, [a.jobId, b.jobId, c.jobId])).queueHold,
          null,
        );
        const advanced = await worker.logLine(a.jobId, "pattern.advanced");
        assert.equal(advanced["outcome"], "running");
        assert.equal(advanced["instance"], "created");
        const lines = worker.logEntries();
        let previous = -1;
        for (const job of [a, b, c]) {
          const finish = lines.findIndex(
            (line) => line["event"] === "job.finished" && line["jobId"] === job.jobId,
          );
          assert(finish > previous);
          const steps = lines.flatMap((line, index) =>
            line["event"] === "job.step" && line["jobId"] === job.jobId ? [index] : [],
          );
          assert.equal(steps.length, 3);
          assert(
            steps.every((index) => index > previous && index < finish),
            "all steps follow the previous job's end",
          );
          previous = finish;
        }
        const rows = rowsSchema.parse(await fixture("rows", pattern.id));
        assert.deepEqual(
          rows.map(({ jobId, state, generation }) => ({ jobId, state, generation })),
          [a, b, c].map(({ jobId }) => ({ jobId, state: "failed", generation: 1 })),
        );
        assert(rows[0] && rows[1] && rows[2]);
        assert(rows[0].updatedAt < rows[1].updatedAt && rows[1].updatedAt < rows[2].updatedAt);
      },
    );
  },
);
