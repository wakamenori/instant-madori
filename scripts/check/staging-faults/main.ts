import assert, { AssertionError } from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import ts from "typescript";
import { z } from "zod";
import { jobTestHoldSettingSchema } from "../../../apps/worker/src/services/job-test-hold.ts";
import {
  acceptInstructionResponseSchema,
  apiErrorSchema,
  cancelQueueResponseSchema,
  meResponseSchema,
  patternResponseSchema,
  patternStateResponseSchema,
  projectListResponseSchema,
  resumeQueueResponseSchema,
  stopJobResponseSchema,
} from "../../../packages/contracts/src/index.ts";
import { repositoryRoot } from "../../shared/repository.ts";
import { credentialsSchema } from "../r2-create-only/rest.ts";
import { stagingTarget, type ServiceToken, type StagingTarget } from "../staging-smoke.ts";
import { judge, readSnapshot, type Delta } from "./history.ts";
import { judgeLogs, queryLogs, type LogExpectation } from "./logs.ts";

import { JourneyFailure, adoptDeploy, polling, type Clock } from "./deploy.ts";
type Options = {
  target: StagingTarget;
  token: ServiceToken;
  cloudflare: z.infer<typeof credentialsSchema>;
  deployRun: string;
  service: string;
};
type Dependencies = {
  fetcher: typeof fetch;
  gh: (args: readonly string[]) => Promise<string>;
  clock: Clock;
  evidence: (file: string, content: string) => Promise<void>;
};
export function faultTarget(jsonc: string) {
  const {
    env: { staging },
  } = z
    .object({
      env: z.object({
        staging: z.object({ name: z.string().min(1), vars: jobTestHoldSettingSchema }),
      }),
    })
    .parse(ts.parseConfigFileTextToJson("wrangler.jsonc", jsonc).config);
  assert(staging.vars?.at === "before_render", "staging JOB_TEST_HOLD must be before_render");
  return { ...stagingTarget(jsonc), service: staging.name };
}
export async function runFaultJourney(
  options: Options,
  { clock, fetcher, gh, evidence }: Dependencies,
) {
  const {
    target: { origin, jobTimeoutMs },
    token,
    deployRun,
    service,
  } = options;
  const started = clock.now();
  const deploy = await adoptDeploy(deployRun, gh, clock);
  const poll = polling(clock);
  async function request(path: string, body?: object, status = 200) {
    const response = await fetcher(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        "CF-Access-Client-Id": token.clientId,
        "CF-Access-Client-Secret": token.clientSecret,
        ...(body ? { origin, "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    assert.equal(
      response.status,
      status,
      `${path} expected HTTP ${status}, received ${response.status}`,
    );
    return response;
  }
  const me = meResponseSchema.parse(await (await request("/api/me")).json());
  assert(me.user.email === "verifier@staging.invalid", "journey requires the verifier user");
  const projects = projectListResponseSchema.parse(await (await request("/api/projects")).json());
  const [project] = projects.projects;
  assert(
    project && projects.projects.length === 1 && projects.nextCursor === null,
    "verifier must have exactly one project",
  );
  // This ID preserves revisions from earlier runs, including those created by earlier code.
  const { pattern } = patternResponseSchema.parse(
    await (
      await request(
        `/api/projects/${project.id}/patterns`,
        { requestId: "cbcc96a9-4aad-4c0c-b089-0ce68af06d11", name: "障害試験" },
        201,
      )
    ).json(),
  );
  assert(pattern.projectId === project.id, "journey pattern belongs to verifier project");
  const base = "/api/patterns/" + pattern.id;
  const state = async () =>
    patternStateResponseSchema.parse(await (await request(base + "/state")).json());
  const stopPath = (id: string) => `/api/jobs/${id}/stop`;
  const fresh = () => ({ requestId: randomUUID() });
  await poll(
    "settling previous jobs",
    async () => {
      const s = await state();
      if (s.queueHold)
        cancelQueueResponseSchema.parse(
          await (
            await request(base + "/queue/cancel", { ...fresh(), heldBy: s.queueHold.job.jobId })
          ).json(),
        );
      else {
        for (const job of [...s.queuedJobs, ...(s.runningJob ? [s.runningJob] : [])])
          stopJobResponseSchema.parse(await (await request(stopPath(job.jobId), fresh())).json());
      }
      return s;
    },
    (s) => !s.runningJob && !s.queueHold && !s.queuedJobs.length,
    clock.now() + jobTimeoutMs,
  );
  let before = await readSnapshot(request, pattern.id);
  const records: object[] = [];
  const ids: Record<string, string> = {};
  const jsonl = (rows: readonly object[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");
  async function step(name: string, adds: 0 | 1, act: () => Promise<Delta>) {
    const start = clock.now();
    let after;
    let delta: Delta | undefined;
    const violations: string[] = [];
    try {
      delta = await act();
      after = await readSnapshot(request, pattern.id);
      violations.push(...judge(before, after, delta));
    } catch (error) {
      violations.push(
        error instanceof AssertionError || error instanceof JourneyFailure
          ? error.message
          : "step request or response failed",
      );
    }
    const missedWindow = !violations.length && adds === 1 && delta?.adds === 0;
    const outcome = violations.length ? "FAIL" : missedWindow ? "MISSED" : "PASS";
    records.push({
      outcome,
      name,
      patternId: pattern.id,
      delta: delta ?? { adds },
      before,
      after: after ?? null,
      violations,
      jobIds: { ...ids },
      start,
      end: clock.now(),
    });
    await evidence("journey.jsonl", jsonl(records));
    console.log(
      `${outcome} ${name}  +${delta?.adds ?? adds}  ${before.history.length} -> ${after?.history.length ?? "?"}  (${(clock.now() - start) / 1000}s)`,
    );
    if (!after || violations.length) throw new JourneyFailure(name + ": " + violations.join(", "));
    before = after;
  }
  const instruction = () => ({ ...fresh(), body: "平屋の案を作成してください" });
  async function send(label: string, body = instruction()) {
    const path = base + "/messages";
    const bytes = Buffer.from(await (await request(path, body, 202)).arrayBuffer());
    const { job } = acceptInstructionResponseSchema.parse(JSON.parse(bytes.toString()));
    ids[label] = job.jobId;
    return { job, replay: () => replay(path, body, bytes, 202) };
  }
  async function replay(path: string, body: object, bytes: Buffer, status: number) {
    assert(
      bytes.equals(Buffer.from(await (await request(path, body, status)).arrayBuffer())),
      "replay changed response bytes",
    );
  }
  async function reuse(path: string, body: object) {
    const error = apiErrorSchema.parse(await (await request(path, body, 422)).json());
    assert.equal(error.error, "request_id_reused", "different request must reject reused ID");
  }
  async function finished(id: string, expected: "completed" | "cancelled", extra = 0) {
    const s = await poll(
      "job " + id,
      state,
      (s) => s.lastFinishedJob?.jobId === id,
      clock.now() + jobTimeoutMs + extra,
    );
    assert.equal(s.lastFinishedJob?.state, expected, `job ${id} expected ${expected}`);
    return s.lastFinishedJob;
  }
  async function stop(id: string) {
    const path = stopPath(id);
    const body = fresh();
    const bytes = Buffer.from(await (await request(path, body)).arrayBuffer());
    const result = stopJobResponseSchema.parse(JSON.parse(bytes.toString()));
    assert(result.job.jobId === id, "stop returned a different job");
    return { result, body, replay: () => replay(path, body, bytes, 200) };
  }
  async function stopHeld(id: string) {
    await poll(
      "running job " + id,
      state,
      (s) => s.runningJob?.jobId === id,
      clock.now() + jobTimeoutMs,
    );
    await clock.sleep(10_000);
    const stopped = await stop(id);
    assert(
      stopped.result.outcome === "stopped" && stopped.result.job.state === "cancelled",
      "held job should stop",
    );
    return stopped;
  }
  const expected: LogExpectation[] = [];
  const bodyA = instruction();
  let acceptedA: Awaited<ReturnType<typeof send>>;
  await step("instruction replay", 1, async () => {
    acceptedA = await send("A", bodyA);
    const id = acceptedA.job.jobId;
    await acceptedA.replay();
    await reuse(base + "/messages", { ...bodyA, body: "別の指示" });
    await reuse(stopPath(id), { requestId: bodyA.requestId });
    await finished(id, "completed");
    expected.push({ kind: "committed", jobId: id });
    return { adds: 1, committedBy: id };
  });
  await step("stop after commit", 0, async () => {
    const stopped = await stop(acceptedA.job.jobId);
    assert(
      stopped.result.outcome === "already_finished" &&
        stopped.result.job.state === "completed" &&
        stopped.result.job.revision.id === before.current,
      "stop must report the committed revision",
    );
    await stopped.replay();
    await acceptedA.replay();
    return { adds: 0 };
  });
  await step("stop while held", 0, async () => {
    const { job } = await send("S");
    const stopped = await stopHeld(job.jobId);
    await stopped.replay();
    await reuse(stopPath(acceptedA.job.jobId), stopped.body);
    await finished(job.jobId, "cancelled");
    expected.push({ kind: "stopped", jobId: job.jobId, held: true });
    return { adds: 0 };
  });
  await step("redeploy while held", 1, async () => {
    if (!(await deploy.waitForWindow())) return { adds: 0 };
    const { job } = await send("R");
    await finished(job.jobId, "completed", 120_000);
    expected.push({ kind: "committed", jobId: job.jobId });
    return { adds: 1, committedBy: job.jobId };
  });
  await step("queue hold after a stop, then resume", 1, async () => {
    const { job: q1 } = await send("Q1");
    const { job: q2 } = await send("Q2");
    await stopHeld(q1.jobId);
    async function checkHold() {
      const s = await state();
      assert(
        s.runningJob === null &&
          s.queueHold?.job.jobId === q1.jobId &&
          s.queueHold.job.state === "cancelled",
        "queue should remain held by the stopped job",
      );
      assert.deepEqual(s.queuedJobs, [q2], "only Q2 waits");
    }
    await checkHold();
    await clock.sleep(30_000);
    await checkHold();
    const path = base + "/queue/resume";
    const body = { ...fresh(), heldBy: q1.jobId };
    const bytes = Buffer.from(await (await request(path, body)).arrayBuffer());
    assert.deepEqual(
      resumeQueueResponseSchema.parse(JSON.parse(bytes.toString())).jobs,
      [q2],
      "resume returns Q2",
    );
    await replay(path, body, bytes, 200);
    await finished(q2.jobId, "completed");
    expected.push(
      { kind: "stopped", jobId: q1.jobId, held: false },
      { kind: "committed", jobId: q2.jobId },
    );
    return { adds: 1, committedBy: q2.jobId };
  });
  const logStart = clock.now();
  const logDeadline = logStart + 720_000;
  const deployment = await deploy.waitForResult();
  await evidence("deploy-run.json", JSON.stringify(deployment, null, 2) + "\n");
  assert(deployment.conclusion === "success", "deploy run did not succeed");
  if (ids.R) {
    assert(
      deployment?.completedAt && Number.isFinite(Date.parse(deployment.completedAt)),
      "missing deploy completion time",
    );
    expected.push({
      kind: "restart",
      jobId: ids.R,
      deployStepCompletedAt: Date.parse(deployment.completedAt),
    });
  }
  const logs = (key: "patternId" | "traceId", value: string) =>
    queryLogs(
      { fetcher, credentials: options.cloudflare },
      { service, key, value, from: started - 60_000, to: clock.now() },
    );
  for (;;) {
    const lines = await logs("patternId", pattern.id);
    await evidence("logs.jsonl", jsonl(lines));
    const verdict = judgeLogs(lines, expected);
    if (verdict.kind === "pending" && clock.now() < logDeadline) {
      await clock.sleep(Math.min(60_000, logDeadline - clock.now()));
      continue;
    }
    const violations =
      verdict.kind === "failed"
        ? verdict.reasons
        : verdict.kind === "pending"
          ? ["missing logs: " + verdict.waitingFor.join(", ")]
          : [];
    records.push({
      name: "log evidence",
      patternId: pattern.id,
      start: logStart,
      end: clock.now(),
      jobIds: { ...ids },
      verdict,
      violations,
    });
    await evidence("journey.jsonl", jsonl(records));
    if (verdict.kind === "failed" || verdict.kind === "pending")
      throw new JourneyFailure("FAIL log evidence: " + violations.join(", "));
    const previous = lines
      .slice()
      .reverse()
      .find((l) => l.jobId === ids.A && l.step === "render snapshot" && l.outcome === "saved");
    const container = ids.R
      ? (await logs("traceId", ids.R)).filter((l) => l.event.startsWith("container."))
      : [];
    await evidence(
      "container.jsonl",
      jsonl(
        container.map((l) => ({
          ...l,
          secondsSincePreviousRender: previous ? (l.at - previous.at) / 1000 : null,
        })),
      ),
    );
    console.log(verdict.kind.toUpperCase() + " log evidence");
    await step("stopped Workflows ended without a revision", 0, () => Promise.resolve({ adds: 0 }));
    return verdict;
  }
}
if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { "deploy-run": { type: "string" }, evidence: { type: "string" } },
    });
    const deployRun = z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .parse(values["deploy-run"]);
    const dir = z.string().min(1).parse(values.evidence);
    const env = credentialsSchema
      .extend({
        STAGING_ACCESS_CLIENT_ID: z.string().trim().min(1),
        STAGING_ACCESS_CLIENT_SECRET: z.string().trim().min(1),
      })
      .parse(process.env);
    const target = faultTarget(
      await readFile(new URL("apps/worker/wrangler.jsonc", repositoryRoot), "utf8"),
    );
    await mkdir(dir, { recursive: true });
    const result = await runFaultJourney(
      {
        target,
        service: target.service,
        token: {
          clientId: env.STAGING_ACCESS_CLIENT_ID,
          clientSecret: env.STAGING_ACCESS_CLIENT_SECRET,
        },
        cloudflare: env,
        deployRun,
      },
      {
        fetcher: fetch,
        gh: async (args) => (await promisify(execFile)("gh", [...args])).stdout,
        clock: { now: Date.now, sleep: (ms) => setTimeout(ms) },
        evidence: (file, data) => writeFile(join(dir, file), data),
      },
    );
    console.log(
      result.kind === "pass"
        ? "PASS staging fault journey"
        : "MISSED " + result.why + "; request another dispatch and rerun",
    );
    process.exitCode = result.kind === "pass" ? 0 : 2;
  } catch (error) {
    console.error(
      error instanceof JourneyFailure || error instanceof AssertionError
        ? error.message
        : "Staging fault journey failed",
    );
    process.exitCode = 1;
  }
}
