import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { jobTestHoldSettingSchema } from "../../apps/worker/src/services/job-test-hold.ts";
import ts from "typescript";
import { z } from "zod";
import {
  acceptInstructionResponseSchema,
  cancelQueueResponseSchema,
  patternStateResponseSchema,
  createProjectResponseSchema,
  displayContentType,
  meResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
} from "../../packages/contracts/src/index.ts";
import type { CreateProjectRequest, RenameRequest } from "../../packages/contracts/src/index.ts";
import { repositoryRoot } from "../shared/repository.ts";

export type ServiceToken = { clientId: string; clientSecret: string };

// Keep this request and its body stable: replaying it reuses the verifier's only project.
const createProject = {
  requestId: "7e54d9ae-4fd0-4c26-8c90-3c18ce1c64d5",
  name: "Staging smoke",
} satisfies CreateProjectRequest;
const missingProjectId = "00000000-0000-4000-8000-000000000000";
// No request waits on the Container because the job does that work.
const requestTimeoutMs = 30_000;
// Covers cold Container readiness (60s), display generation (30s), and one render retry with headroom.
const renderBudgetMs = 240_000;
export type StagingTarget = { origin: string; jobTimeoutMs: number };

export async function smokeStaging(
  { origin, jobTimeoutMs }: StagingTarget,
  token: ServiceToken,
  {
    fetcher = fetch,
    pollIntervalMs = 2_000,
  }: { fetcher?: typeof fetch; pollIntervalMs?: number } = {},
): Promise<void> {
  const withToken = {
    "CF-Access-Client-Id": token.clientId,
    "CF-Access-Client-Secret": token.clientSecret,
  };
  const request = (path: string, init: RequestInit = {}) =>
    fetcher(`${origin}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: { ...withToken, ...init.headers },
    });
  const anonymous = await fetcher(`${origin}/api/health`, {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert.equal(anonymous.status, 302, "Access redirects requests without credentials");
  const health = await request("/api/health");
  assert.equal(health.status, 200, "health answers through Access");
  assert.deepEqual(await health.json(), { status: "ok", service: "worker" });
  const me = await request("/api/me");
  assert.equal(me.status, 200, "the Worker accepts the verifier service token");
  assert.equal(meResponseSchema.parse(await me.json()).user.email, "verifier@staging.invalid");

  const mutationHeaders = { "content-type": "application/json", origin };
  const created = await request("/api/projects", {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify(createProject),
  });
  assert.equal(created.status, 201, "the verifier creates or replays its project");
  const { project, pattern } = createProjectResponseSchema.parse(await created.json());
  assert.equal(pattern.projectId, project.id, "the first pattern belongs to the project");

  const listProjects = async () => {
    const response = await request("/api/projects");
    assert.equal(response.status, 200, "the verifier can list its project");
    const page = projectListResponseSchema.parse(await response.json());
    assert.equal(page.nextCursor, null, "the verifier has only one page");
    assert.equal(page.projects.length, 1, "the verifier has exactly one project");
    const current = page.projects[0];
    assert.ok(current);
    assert.equal(current.id, project.id, "creation reuses the same project");
    return current;
  };
  const current = await listProjects();
  const rename = {
    requestId: randomUUID(),
    version: current.version,
    name: `Staging smoke ${current.version + 1}`,
  } satisfies RenameRequest;
  const renamed = await request(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: mutationHeaders,
    body: JSON.stringify(rename),
  });
  assert.equal(renamed.status, 200, "the verifier can rename its project");
  const updated = projectResponseSchema.parse(await renamed.json()).project;
  assert.equal(updated.id, project.id, "renaming preserves the project ID");
  assert.equal(updated.name, rename.name, "renaming changes the project name");
  assert.equal(updated.version, current.version + 1, "renaming increments the version once");
  assert.deepEqual(await listProjects(), updated, "a fresh read reflects the rename");

  const missing = await request(`/api/projects/${missingProjectId}/patterns`);
  assert.equal(missing.status, 404, "a nonexistent project is not found");
  assert.deepEqual(await missing.json(), { error: "not_found" });

  const patternPath = `/api/patterns/${pattern.id}`;
  const readState = async () => {
    const response = await request(`${patternPath}/state`);
    assert.equal(response.status, 200, "the verifier can read the pattern state");
    return patternStateResponseSchema.parse(await response.json());
  };
  const before = await readState();
  if (before.queueHold) {
    const cancel = await request(`${patternPath}/queue/cancel`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ requestId: randomUUID(), heldBy: before.queueHold.job.jobId }),
    });
    assert.equal(cancel.status, 200, "the verifier can release a previous job's queue hold");
    cancelQueueResponseSchema.parse(await cancel.json());
  }
  const accepted = await request(`${patternPath}/messages`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ requestId: randomUUID(), body: "疎通の確認" }),
  });
  assert.equal(accepted.status, 202, "the verifier's instruction is accepted");
  const { job } = acceptInstructionResponseSchema.parse(await accepted.json());
  const deadline = Date.now() + jobTimeoutMs;
  let state = await readState();
  while (state.lastFinishedJob?.jobId !== job.jobId) {
    assert.ok(Date.now() < deadline, `the job finishes within ${jobTimeoutMs} ms`);
    await setTimeout(pollIntervalMs);
    state = await readState();
  }
  const finished = state.lastFinishedJob;
  assert.equal(finished.state, "completed", "the accepted job completed");
  assert.notEqual(
    finished.revision.id,
    before.currentRevision?.id,
    "the job created a new revision",
  );
  assert.equal(
    finished.revision.id,
    state.currentRevision?.id,
    "the completed revision is current",
  );
  const revisionId = finished.revision.id;
  const display = await request(`/api/revisions/${revisionId}/view`);
  assert.equal(display.status, 200, "the verifier can view the committed revision");
  assert.equal(
    display.headers.get("content-type"),
    displayContentType,
    "the revision returns display data",
  );
  assert.equal(
    display.headers.get("x-revision-id"),
    revisionId,
    "the view identifies the committed revision",
  );
  assert.ok((await display.arrayBuffer()).byteLength > 0, "display data is not empty");
}

export function stagingTarget(wranglerJsonc: string): StagingTarget {
  const config = z
    .object({
      env: z.object({ staging: z.object({ vars: z.looseObject({ APP_ORIGINS: z.string() }) }) }),
    })
    .parse(ts.parseConfigFileTextToJson("wrangler.jsonc", wranglerJsonc).config);
  const origins = config.env.staging.vars.APP_ORIGINS.split(/\s+/).filter(
    (origin) => origin !== "",
  );
  assert.equal(origins.length, 1, "staging serves one origin");
  const hold = jobTestHoldSettingSchema.parse(config.env.staging.vars);
  const origin = z
    .url()
    .refine((value) => new URL(value).origin === value)
    .parse(origins[0]);
  return { origin, jobTimeoutMs: (hold?.seconds ?? 0) * 1000 + renderBudgetMs };
}

if (import.meta.main) {
  try {
    const env = z
      .object({
        STAGING_ACCESS_CLIENT_ID: z.string().trim().min(1),
        STAGING_ACCESS_CLIENT_SECRET: z.string().trim().min(1),
      })
      .parse(process.env);
    const target = stagingTarget(
      readFileSync(new URL("apps/worker/wrangler.jsonc", repositoryRoot), "utf8"),
    );
    await smokeStaging(target, {
      clientId: env.STAGING_ACCESS_CLIENT_ID,
      clientSecret: env.STAGING_ACCESS_CLIENT_SECRET,
    });
    console.log(`Staging smoke passed: ${target.origin}`);
  } catch {
    // Responses and fetch errors can contain credentials; never dump them to deploy logs.
    console.error("Staging smoke failed");
    process.exitCode = 1;
  }
}
