import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";
import { freePort, ready, start, stop, cleanupSteps } from "../../shared/processes.ts";
import { prefix, replySchema, verifyCreateOnly } from "./protocol.ts";
import { credentialsSchema, stagingR2Rest } from "./rest.ts";

async function main() {
  const credentials = credentialsSchema.parse(process.env);
  const config = z
    .object({
      compatibility_date: z.string(),
      env: z.object({
        staging: z.object({
          r2_buckets: z.array(z.object({ binding: z.string(), bucket_name: z.string() })),
        }),
      }),
    })
    .parse(
      ts.parseConfigFileTextToJson(
        "wrangler.jsonc",
        await readFile(new URL("../../../apps/worker/wrangler.jsonc", import.meta.url), "utf8"),
      ).config,
    );
  const bindings = config.env.staging.r2_buckets.filter(({ binding }) => binding === "BLOBS");
  assert.equal(bindings.length, 1, "staging must have exactly one BLOBS binding");
  const binding = bindings[0];
  assert(binding);
  assert.equal(binding.bucket_name, "instant-madori-staging", "probe is restricted to staging");
  const rest = stagingR2Rest(credentials, binding.bucket_name);
  const before = await rest.scripts();
  console.log(`Worker scripts before: ${JSON.stringify(before)}`);
  await rest.recover();
  const directory = await mkdtemp(join(tmpdir(), "madori-r2-check-"));
  const processes: ReturnType<typeof start>[] = [];
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort(new Error("R2 check interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const failures: unknown[] = [];
  try {
    const key = `${prefix}${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const path = join(directory, "wrangler.json");
    await writeFile(
      path,
      JSON.stringify({
        name: "madori-r2-create-only-check",
        main: fileURLToPath(new URL("worker.ts", import.meta.url)),
        compatibility_date: config.compatibility_date,
        compatibility_flags: ["nodejs_compat"],
        account_id: credentials.CLOUDFLARE_ACCOUNT_ID,
        r2_buckets: [{ ...binding, preview_bucket_name: binding.bucket_name }],
        vars: { PROBE_TOKEN: token, PROBE_KEY: key },
      }),
      { mode: 0o600 },
    );
    const port = await freePort();
    const worker = start(
      "pnpm",
      [
        "--filter",
        "@madori/worker",
        "exec",
        "wrangler",
        "dev",
        "--remote",
        "--config",
        path,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "0",
      ],
      {
        env: { ...process.env, ...credentials, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    processes.push(worker);
    // Wrangler prints temporary binding values, including the probe credential, at startup.
    worker.child.stdout?.resume();
    worker.child.stderr?.resume();
    const origin = `http://127.0.0.1:${port}`;
    await ready(`${origin}/health`, worker.child, 120_000);
    console.log(`Edge preview ready: bucket=${binding.bucket_name}, key=${key}`);
    await verifyCreateOnly(
      async (step) => {
        if (step !== "delete") interrupted.signal.throwIfAborted();
        const response = await fetch(`${origin}/${step}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        const body: unknown = await response.json();
        assert.equal(response.status, 200, `Edge ${step} failed: ${JSON.stringify(body)}`);
        assert.deepEqual(replySchema.parse(body), { ok: true, step, key });
        const result = {
          first: "putNew saved A",
          reject: "putNew threw already exists",
          direct: "conditional put returned null",
          delete: "key absent",
        }[step];
        console.log(`Edge ${step}: ${result}`);
      },
      async (step) => rest.observe(key, step),
    );
  } catch (error) {
    failures.push(error);
  } finally {
    failures.push(
      ...(await cleanupSteps([
        () => stop(processes),
        async () => {
          const after = await rest.scripts();
          assert.deepEqual(after, before, "Worker scripts must remain unchanged");
          console.log(`Worker scripts after: ${JSON.stringify(after)} (unchanged)`);
        },
        () => rm(directory, { recursive: true, force: true }),
      ])),
    );
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (failures.length) throw new AggregateError(failures, "Staging R2 check failed");
  console.log("Staging R2 create-only check passed in Cloudflare edge preview");
}

if (import.meta.main) await main();
