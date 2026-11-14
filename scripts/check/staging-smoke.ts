import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";
import { z } from "zod";
import { repositoryRoot } from "../shared/repository.ts";

export type ServiceToken = { clientId: string; clientSecret: string };

/**
 * Checks a deployed staging Worker through its Access app. The Worker rejects service-token
 * identities by design, so an authenticated route answering 403 (not 401) proves that the
 * Worker verified a real Access JWT against its configured issuer and audience.
 */
export async function smokeStaging(
  origin: string,
  token: ServiceToken,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const withToken = {
    "CF-Access-Client-Id": token.clientId,
    "CF-Access-Client-Secret": token.clientSecret,
  };
  const anonymous = await fetcher(`${origin}/api/health`, { redirect: "manual" });
  assert.equal(anonymous.status, 302, "Access redirects requests without credentials");
  const health = await fetcher(`${origin}/api/health`, { headers: withToken });
  assert.equal(health.status, 200, "health answers through Access");
  assert.deepEqual(await health.json(), { status: "ok", service: "worker" });
  const me = await fetcher(`${origin}/api/me`, { headers: withToken });
  assert.equal(me.status, 403, "the Worker verifies the Access JWT and rejects service tokens");
  assert.deepEqual(await me.json(), { error: "forbidden" });
}

export function stagingOrigin(wranglerJsonc: string): string {
  const config = z
    .object({
      env: z.object({ staging: z.object({ vars: z.object({ APP_ORIGINS: z.string() }) }) }),
    })
    .parse(ts.parseConfigFileTextToJson("wrangler.jsonc", wranglerJsonc).config);
  const origins = config.env.staging.vars.APP_ORIGINS.split(",");
  assert.equal(origins.length, 1, "staging serves one origin");
  return z.url().parse(origins[0]);
}

if (import.meta.main) {
  const env = z
    .object({
      STAGING_ACCESS_CLIENT_ID: z.string().min(1),
      STAGING_ACCESS_CLIENT_SECRET: z.string().min(1),
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
}
