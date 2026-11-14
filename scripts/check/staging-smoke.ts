import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import {
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
// Covers Container readiness (60s) and display generation (30s), with network headroom.
const requestTimeoutMs = 120_000;

export async function smokeStaging(
  origin: string,
  token: ServiceToken,
  fetcher: typeof fetch = fetch,
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

  const display = await request("/api/sample/display");
  assert.equal(display.status, 200, "the Container returns sample display data");
  assert.equal(display.headers.get("content-type"), displayContentType);
  assert.ok((await display.arrayBuffer()).byteLength > 0, "display data is not empty");
}

export function stagingOrigin(wranglerJsonc: string): string {
  const config = z
    .object({
      env: z.object({ staging: z.object({ vars: z.object({ APP_ORIGINS: z.string() }) }) }),
    })
    .parse(ts.parseConfigFileTextToJson("wrangler.jsonc", wranglerJsonc).config);
  const origins = config.env.staging.vars.APP_ORIGINS.split(/\s+/).filter(
    (origin) => origin !== "",
  );
  assert.equal(origins.length, 1, "staging serves one origin");
  return z
    .url()
    .refine((value) => new URL(value).origin === value)
    .parse(origins[0]);
}

if (import.meta.main) {
  try {
    const env = z
      .object({
        STAGING_ACCESS_CLIENT_ID: z.string().trim().min(1),
        STAGING_ACCESS_CLIENT_SECRET: z.string().trim().min(1),
      })
      .parse(process.env);
    const origin = stagingOrigin(
      readFileSync(new URL("apps/worker/wrangler.jsonc", repositoryRoot), "utf8"),
    );
    await smokeStaging(origin, {
      clientId: env.STAGING_ACCESS_CLIENT_ID,
      clientSecret: env.STAGING_ACCESS_CLIENT_SECRET,
    });
    console.log(`Staging smoke passed: ${origin}`);
  } catch {
    // Responses and fetch errors can contain credentials; never dump them to deploy logs.
    console.error("Staging smoke failed");
    process.exitCode = 1;
  }
}
