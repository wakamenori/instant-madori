import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";

const wrapper = resolve(import.meta.dirname, "wrangler-deploy.ts");
const client = "synthetic-client.access";
const args = ["--env", "staging", "--var", `ACCESS_VERIFIER_CLIENT_ID:${client}`];
const settings =
  "The Worker version was deployed, but its Durable Object-managed Container application settings were not fully applied. Re-run the same `wrangler deploy` command to retry and finish deployment.";
const warning =
  "::warning title=wrangler deploy re-run::Attempt 1 of 3 deployed the Worker version but did not finish its Container application settings; running wrangler deploy again (attempt 2 of 3).";
const exhausted =
  "::error title=wrangler deploy::All 3 attempts deployed the Worker version but did not finish its Container application settings; giving up.";
const success = (n: number) => `wrangler deploy succeeded on attempt ${n} of 3.`;
const failure = (reason: string, n = 1) =>
  `wrangler deploy failed on attempt ${n} of 3 (${reason}); not running it again.`;

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "wrangler-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runner = join(cwd, "runner");
  await mkdir(runner);
  async function run(
    env: NodeJS.ProcessEnv,
    { interrupt = false, abort }: { interrupt?: boolean; abort?: AbortSignal } = {},
  ) {
    const signal = abort ? AbortSignal.any([t.signal, abort]) : t.signal;
    signal.throwIfAborted();
    const child = spawn(process.execPath, [wrapper, ...args], {
      cwd,
      env: { ...env, RUNNER_TEMP: runner },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    function stop() {
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    signal.addEventListener("abort", stop);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => {
      output += part;
      if (interrupt && output.includes("ready for SIGTERM\n")) {
        interrupt = false;
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (part: string) => {
      output += part;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) {
      assert.ok(pid);
      assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
      signal.throwIfAborted();
    }
    assert.ok(!output.includes(client), "client ID appeared in logs");
    assert.deepEqual(await readdir(runner), []);
    return { code, lines: output.split("\n") };
  }
  return { cwd, run, runner };
}

const entry = (message: string, version = 1) =>
  JSON.stringify({ type: "command-failed", version, message });
type Step = { code: number; lines?: string[]; stderr?: string; wait?: boolean };
const deployed = { code: 0 };
const partial = { code: 1, lines: [entry(settings)] };
const other = { code: 1, lines: [entry("different error")] };
const callSchema = z.object({ args: z.array(z.string()), path: z.string(), existed: z.boolean() });

async function fake(t: TestContext, plan: Step[]) {
  const { cwd, run, runner } = await fixture(t);
  const bin = join(cwd, "bin");
  await mkdir(bin);
  if (plan.length)
    await writeFile(
      join(bin, "wrangler"),
      `#!${process.execPath}
const fs = require("node:fs");
const plan = ${JSON.stringify(plan)};
const index = fs.existsSync("calls") ? fs.readFileSync("calls", "utf8").trimEnd().split("\\n").length : 0;
const path = process.env.WRANGLER_OUTPUT_FILE_PATH;
const args = process.argv.slice(2);
fs.appendFileSync("calls", JSON.stringify({args,path,existed:fs.existsSync(path)}) + "\\n");
fs.appendFileSync(path, JSON.stringify({type:"wrangler-session",version:1,command_line_args:args}) + "\\n");
const step = plan[index];
function finish() {
  for (const line of step.lines ?? []) fs.appendFileSync(path, line + "\\n");
  if (step.stderr) console.error(step.stderr);
  process.exit(step.code);
}
if (step.wait) {
  process.on("SIGTERM", () => { fs.writeFileSync("signal","SIGTERM"); finish(); });
  setInterval(()=>{},1000);
  console.log("ready for SIGTERM");
} else finish();
`,
      { mode: 0o755 },
    );
  const { code, lines } = await run({ PATH: bin }, { interrupt: plan.some((step) => step.wait) });
  const calls = plan.length
    ? (await readFile(join(cwd, "calls"), "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => callSchema.parse(JSON.parse(line)))
    : [];
  assert.equal(new Set(calls.map((call) => call.path)).size, calls.length);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual(call.args, ["deploy", ...args]);
    assert.equal(call.existed, false);
    assert.equal(dirname(dirname(call.path)), runner);
    assert.ok(call.path.endsWith(`/attempt-${index + 1}.ndjson`));
  }
  return { code, lines, count: calls.length, cwd };
}

void test("deploys on the first attempt", async (t) => {
  const r = await fake(t, [deployed]);
  assert.equal(r.code, 0);
  assert.equal(r.count, 1);
  assert.deepEqual(r.lines, [success(1), ""]);
});
void test("re-runs after the Container settings failure and succeeds", async (t) => {
  const r = await fake(t, [partial, deployed]);
  assert.deepEqual(r.lines, [warning, success(2), ""]);
  assert.equal(r.count, 2);
  assert.equal(r.code, 0);
});
void test("gives up after three Container settings failures", async (t) => {
  const r = await fake(t, [partial, partial, partial, partial]);
  assert.equal(r.count, 3);
  assert.equal(r.code, 1);
  assert.ok(r.lines.includes(exhausted));
});

const failures: [string, Step[], string][] = [
  ["different message", [other], "another error"],
  ["extra sentence", [{ code: 1, lines: [entry(settings + " Retry.")] }], "another error"],
  [
    "different command",
    [{ code: 1, lines: [entry(settings.replace("wrangler deploy", "wrangler versions deploy"))] }],
    "another error",
  ],
  ["stderr only", [{ code: 1, stderr: settings }], "no command-failed entry"],
  ["invalid JSON", [{ code: 1, lines: ["oops"] }], "unreadable output file"],
  ["unknown version", [{ code: 1, lines: [entry(settings, 2)] }], "unreadable output file"],
  ["launcher signal", [{ ...partial, code: 143 }], "stopped by a signal"],
  ["missing executable", [], "wrangler could not start"],
  ["duplicate entry", [{ code: 1, lines: [entry(settings), entry(settings)] }], "another error"],
  ["other exit code", [{ ...partial, code: 2 }], "another error"],
];
for (const [name, plan, reason] of failures)
  void test(`does not re-run: ${name}`, async (t) => {
    const r = await fake(t, plan);
    assert.equal(r.code, 1);
    assert.equal(r.count, plan.length);
    assert.ok(r.lines.includes(failure(reason)));
  });
void test("stops on another error after retry", async (t) => {
  const r = await fake(t, [partial, other]);
  assert.equal(r.count, 2);
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, [warning, failure("another error", 2), ""]);
});
void test("forwards SIGTERM and cleans up", { timeout: 10000 }, async (t) => {
  const r = await fake(t, [{ ...partial, code: 143, wait: true }]);
  assert.equal(await readFile(join(r.cwd, "signal"), "utf8"), "SIGTERM");
  assert.equal(r.code, 143);
  assert.equal(r.count, 1);
  assert.ok(r.lines.includes("wrangler deploy interrupted by SIGTERM; not running it again."));
});

void test(
  "does not re-run after SIGTERM when wrangler reports the Container settings failure",
  { timeout: 10000 },
  async (t) => {
    const r = await fake(t, [{ ...partial, wait: true }, deployed]);
    assert.equal(await readFile(join(r.cwd, "signal"), "utf8"), "SIGTERM");
    assert.equal(r.count, 1);
    assert.equal(r.code, 143);
    assert.deepEqual(r.lines, [
      "ready for SIGTERM",
      "wrangler deploy interrupted by SIGTERM; not running it again.",
      "",
    ]);
  },
);

async function realWrangler(t: TestContext, mode: "accept" | "reject" | "hang") {
  const { cwd, run } = await fixture(t);
  const staging = {
    name: "probe-worker",
    workers_dev: false,
    preview_urls: false,
    containers: [{ class_name: "Geo", scheduling_policy: "durable_object" }],
    durable_objects: { bindings: [{ name: "GEO", class_name: "Geo" }] },
    exports: { Geo: { type: "durable-object", storage: "sqlite" } },
  };
  await writeFile(
    join(cwd, "wrangler.jsonc"),
    JSON.stringify({
      name: "probe",
      main: "index.js",
      compatibility_date: "2026-11-08",
      env: { staging },
    }),
  );
  await writeFile(
    join(cwd, "index.js"),
    'export class Geo {}\nexport default { fetch() { return new Response("ok"); } };',
  );
  const home = join(cwd, "home");
  const tmp = join(cwd, "tmp");
  await mkdir(home);
  await mkdir(tmp);

  const controller = new AbortController();
  let uploads = 0;
  let missingVersionGets = 0;
  const server = createServer((req, res) => {
    req.resume();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    let result: unknown = {};
    let error: { code: number; message: string } | undefined;
    if (req.method === "PUT" && path.endsWith("/scripts/probe-worker")) {
      uploads++;
      if (mode === "hang") {
        controller.abort(new Error("upload interrupted"));
        return;
      }
      if (mode === "reject") {
        res.statusCode = 403;
        error = { code: 10000, message: "Authentication error" };
      } else {
        result = {
          id: "probe-worker",
          deployment_id: `d380fc10-0000-4000-8000-${String(uploads).padStart(12, "0")}`,
          startup_time_ms: 1,
        };
      }
    } else if (req.method === "GET" && path.includes("/versions/")) {
      if (path.endsWith("000000000001")) {
        missingVersionGets++;
        res.statusCode = 404;
        error = { code: 100146, message: "This Worker version does not exist." };
      } else
        result = {
          resources: {
            bindings: [
              {
                type: "durable_object_namespace",
                name: "GEO",
                class_name: "Geo",
                namespace_id: "ns-1",
              },
            ],
          },
        };
    } else if (path.endsWith("/services/probe-worker"))
      result = {
        default_environment: {
          script: { tag: "tag", tail_consumers: [], last_deployed_from: "wrangler" },
        },
      };
    else if (path.endsWith("/workers/workers/probe-worker"))
      result = {
        id: "probe-worker",
        name: "probe-worker",
        subdomain: { enabled: false, previews_enabled: false },
        observability: { enabled: false },
        tags: [],
        tail_consumers: [],
      };
    else if (path.endsWith("/secrets")) result = [];
    else if (path.endsWith("/deployments")) result = { deployments: [] };
    else if (path.endsWith("/subdomain")) result = { enabled: false, previews_enabled: false };
    else if (req.method === "GET" && path.includes("/containers/applications/")) {
      res.statusCode = 404;
      error = { code: 1, message: "not found" };
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: !error,
        errors: error ? [error] : [],
        messages: [],
        result: error ? null : result,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const r = await run(
    {
      PATH: [
        resolve(import.meta.dirname, "../../apps/worker/node_modules/.bin"),
        dirname(process.execPath),
        "/usr/bin",
        "/bin",
      ].join(":"),
      HOME: home,
      TMPDIR: tmp,
      CI: "true",
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${address.port}/client/v4`,
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_SEND_ERROR_REPORTS: "false",
      WRANGLER_HIDE_BANNER: "true",
    },
    { abort: controller.signal },
  );
  return { ...r, uploads, missingVersionGets };
}
void test(
  "real Wrangler deploys on the second attempt when the first version is not readable yet",
  { timeout: 30000 },
  async (t) => {
    const r = await realWrangler(t, "accept");
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.equal(r.uploads, 2);
    assert.equal(r.missingVersionGets, 5);
    assert.ok(r.lines.includes(warning));
    assert.ok(r.lines.includes(success(2)));
  },
);
void test(
  "real Wrangler is not re-run after an upload authentication error",
  { timeout: 30000 },
  async (t) => {
    const r = await realWrangler(t, "reject");
    assert.equal(r.code, 1);
    assert.equal(r.uploads, 1, r.lines.join("\n"));
    assert.ok(r.lines.includes(failure("another error")));
  },
);
void test("aborts real Wrangler during upload", { timeout: 30000 }, async (t) => {
  await assert.rejects(realWrangler(t, "hang"), { message: "upload interrupted" });
});
