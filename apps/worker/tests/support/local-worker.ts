// Runs the Worker in workerd through `wrangler dev`, against a fresh local D1 database
// migrated with the real migration files, so tests exercise the deployed code path.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { get } from "node:http";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { accessAssertionHeader } from "@madori/contracts";
import {
  createAccessKey,
  formatEnvFile,
  localWorkerVars,
  signAccessToken,
} from "../../../../scripts/dev/local-access.ts";
import type { AccessKey, AccessUser } from "../../../../scripts/dev/local-access.ts";
import {
  assertSucceeded,
  cleanupSteps,
  freePort,
  ready,
  start,
  stop,
} from "../../../../scripts/shared/processes.ts";
import type { ProcessOutcome } from "../../../../scripts/shared/processes.ts";

const workerDirectory = fileURLToPath(new URL("../../", import.meta.url));
const wrangler = join(workerDirectory, "node_modules/wrangler/bin/wrangler.js");

/**
 * Leads Wrangler's process group and stops Wrangler when its stdin pipe closes, which also
 * happens when the test process is killed before any handler can run. It signals only the
 * Wrangler bin: workerd must not get SIGTERM, because its own container removal makes
 * Miniflare's session cleanup fail before it removes the `-proxy` sidecars.
 */
const lifeline = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.stdin.on("end", () => child.kill("SIGTERM"));
  process.stdin.resume();
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code);
  });
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
`;

export const testAppOrigin = "http://app.test";
/** The stand-in SPA page served as static assets during tests. */
export const testSpaHtml = "<!doctype html><title>test SPA</title>";
/** A second allowed origin, like the dev server's `localhost` name. */
export const testAlternateOrigin = "http://alt.app.test";

interface ApiCall {
  method?: string;
  /** Signs a valid Access token for this user. Omit for an unauthenticated call. */
  as?: AccessUser;
  /** Sent as JSON. */
  body?: unknown;
  /** Origin for mutating methods; defaults to the app origin, null omits the header. */
  origin?: string | null;
  headers?: Record<string, string>;
}

export interface LocalWorker {
  origin: string;
  key: AccessKey;
  /**
   * The structured log line with `event` (by default the per-request `api.request` line)
   * that the Worker wrote for the request with `traceId`.
   */
  logLine(traceId: string, event?: string): Promise<Record<string, unknown>>;
  /** Every structured log entry the Worker has written so far. */
  logEntries(): readonly Record<string, unknown>[];
  /**
   * Requests `path` as a browser navigation would. Only navigations get the SPA fallback
   * for unknown paths, and Node's fetch always sends `sec-fetch-mode: cors`, so this goes
   * through node:http instead.
   */
  navigate(path: string): Promise<{ status: number; contentType: string; body: string }>;
  /** Calls the API as the web app would. */
  call(path: string, options?: ApiCall): Promise<Response>;
  withPausedWorker<T>(action: (state: string) => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

/** A child process whose output is read line by line, each stream on its own. */
interface CapturedProcess {
  process: ChildProcess;
  lines: string[];
  /** Resolves once the process has ended and both output streams are closed (or it never started). */
  closed: Promise<void>;
  outcome: Promise<ProcessOutcome>;
  /** Stops the process group and releases its pipes. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** How many of a process's last output lines an error shows. */
const shownOutputLines = 40;

/** The last lines of captured output, for error messages, noting how many were left out. */
function outputTail(lines: readonly string[]): string {
  const omitted = lines.length - shownOutputLines;
  const tail = lines.slice(-shownOutputLines).join("\n");
  return omitted > 0 ? `(${omitted} earlier lines omitted)\n${tail}` : tail;
}

/** How long to wait for a stopped process's pipes to close before tearing them down. */
const pipeCloseGraceMs = 2_000;

/**
 * How long `logLine` waits. Some lines follow Workflow progress, such as a JOB_TEST_HOLD
 * sleep, which a loaded machine stretches by seconds. It stays below the 120 s suite
 * timeouts, so a line that never comes still fails with its own message.
 */
const logLineDeadlineMs = 30_000;

/** How long Wrangler gets to clean up its Container session before its group is stopped. */
const wranglerExitGraceMs = 10_000;

function startWrangler(args: string[], onLine?: (line: string) => void): CapturedProcess {
  const child = start(process.execPath, ["-e", lifeline, wrangler, ...args], {
    cwd: workerDirectory,
    env: { ...process.env, CI: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  for (const stream of [child.child.stdout, child.child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on("line", (line) => {
      lines.push(line);
      onLine?.(line);
    });
  }
  // "close" comes after "exit", once every output line has been read; a process that never
  // started emits "error" instead. Registered now, because either can fire before anyone waits.
  const closed = new Promise<void>((resolve) => {
    child.child.once("close", () => resolve());
    child.child.once("error", () => resolve());
  });
  let disposing: Promise<void> | undefined;
  return {
    process: child.child,
    lines,
    closed,
    outcome: child.finished,
    dispose() {
      disposing ??= (async () => {
        child.child.stdin?.end();
        await Promise.race([
          child.finished,
          setTimeout(wranglerExitGraceMs, undefined, { ref: false }),
        ]);
        await stop([child]);
        const settled = await Promise.race([
          closed.then(() => true),
          setTimeout(pipeCloseGraceMs, false, { ref: false }),
        ]);
        // A leftover process may still hold the pipes; close our ends so nothing keeps the
        // test process alive.
        if (!settled) {
          child.child.stdout?.destroy();
          child.child.stderr?.destroy();
        }
      })();
      return disposing;
    },
  };
}

/**
 * Runs a wrangler command to completion within `timeoutMs`. Its output becomes the error
 * message on failure, so a failing migration or statement shows D1's own error text.
 */
async function runWrangler(args: string[], timeoutMs = 60_000) {
  const label = `wrangler ${args.slice(0, 2).join(" ")}`;
  const run = startWrangler(args);
  const finished = await Promise.race([
    run.closed.then(() => true),
    setTimeout(timeoutMs, false, { ref: false }),
  ]);
  if (!finished) {
    // Stopping first lets the lines printed during shutdown into the report.
    return failAfterCleanup(
      () => new Error(`${label} timed out after ${timeoutMs} ms:\n${outputTail(run.lines)}`),
      () => run.dispose(),
    );
  }
  assertSucceeded(label, await run.outcome, outputTail(run.lines));
}

const migrate = (state: string) =>
  runWrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);

/**
 * Runs `cleanup` after a failure, then throws the failure, built by `failure` only after the
 * cleanup so that it can include what the cleanup revealed (e.g. a process's last output).
 * A cleanup failure is reported together with it, never instead of it.
 */
async function failAfterCleanup(
  failure: () => unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }
  const error = failure();
  if (cleanupFailed) {
    throw new AggregateError([error, cleanupError], "Failed, and cleanup failed too", {
      cause: cleanupError,
    });
  }
  throw error;
}

/** A fresh local D1 database with every migration applied, in a temporary directory. */
export async function migratedDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "madori-d1-test-"));
  const remove = () => rm(directory, { recursive: true, force: true });
  const state = join(directory, "state");
  try {
    await migrate(state);
  } catch (error) {
    return failAfterCleanup(() => error, remove);
  }
  return {
    state,
    /**
     * Runs SQL directly. Rejects with D1's own error text (e.g. "FOREIGN KEY constraint
     * failed"), so tests can assert which constraint stopped the statement.
     */
    execute: (sql: string) =>
      runWrangler(["d1", "execute", "DB", "--local", "--persist-to", state, "--command", sql]),
    remove,
  };
}

export async function startLocalWorker({
  containers = false,
  readyTimeoutMs = 30_000,
  vars = {},
}: {
  containers?: boolean;
  readyTimeoutMs?: number;
  vars?: Record<string, string>;
} = {}): Promise<LocalWorker> {
  const directory = await mkdtemp(join(tmpdir(), "madori-worker-test-"));
  // Output is captured rather than printed, and shown when the Worker fails to start. Every
  // structured line is parsed once, as it arrives.
  const entries: Record<string, unknown>[] = [];
  let worker: CapturedProcess | undefined;
  let resumeWorker: (() => Promise<void>) | undefined;
  const state = join(directory, "state");

  /** The one teardown, for a failed start and for `stop()` alike. Safe to call again. */
  let disposing: Promise<void> | undefined;
  function dispose() {
    disposing ??= (async () => {
      const problems = await cleanupSteps([
        () => worker?.dispose(),
        () => rm(directory, { recursive: true, force: true }),
      ]);
      if (problems.length > 0) throw new AggregateError(problems, "Local Worker cleanup failed");
    })();
    return disposing;
  }

  let origin: string;
  let key: AccessKey;
  try {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    key = await createAccessKey("https://access.test.invalid", "instant-madori-test");
    const assets = join(directory, "assets");
    const envFile = join(directory, "worker.env");
    await writeFile(
      envFile,
      formatEnvFile({ ...localWorkerVars(key, [testAppOrigin, testAlternateOrigin]), ...vars }),
    );
    await mkdir(assets);
    // A real SPA entry. Only browser navigations get the SPA fallback, so if `/api/*` ever
    // fell through to static assets (for example without `run_worker_first`), only tests
    // that use `navigate()` would see this HTML; fetch-based `call()` still reaches the Worker.
    await writeFile(join(assets, "index.html"), testSpaHtml);
    await migrate(state);

    resumeWorker = async () => {
      const started = startWrangler(
        [
          "dev",
          "--local",
          `--enable-containers=${containers}`,
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--inspector-port",
          "0",
          "--persist-to",
          state,
          "--env-file",
          envFile,
          // API tests do not need the built web app; serve a stand-in SPA entry instead.
          "--assets",
          assets,
          "--show-interactive-dev-session=false",
          // "log" includes the Worker's own console.log lines, which tests read through logLine().
          "--log-level",
          "log",
        ],
        (line) => {
          if (containers) console.info(line);
          const entry = parseLogEntry(line);
          if (entry) entries.push(entry);
        },
      );
      worker = started;
      await ready(`${origin}/api/health`, started.process, readyTimeoutMs);
    };
    await resumeWorker();
  } catch (error) {
    // The Worker's output goes into the error, built after cleanup has read its last lines.
    // The reason leads, so a hang and a crash are told apart without reading the output.
    return failAfterCleanup(() => {
      if (!worker || worker.lines.length === 0) return error;
      const reason = error instanceof Error ? error.message : String(error);
      return new Error(`Local Worker failed to start (${reason}):\n${outputTail(worker.lines)}`, {
        cause: error,
      });
    }, dispose);
  }
  return {
    origin,
    key,
    async logLine(traceId, event = "api.request") {
      if (traceId === "") throw new Error("logLine needs a trace ID");
      // Log lines travel workerd → wrangler → this pipe, so they can arrive after the
      // response.
      const find = () =>
        entries.find((entry) => entry["traceId"] === traceId && entry["event"] === event);
      const deadline = Date.now() + logLineDeadlineMs;
      while (Date.now() < deadline) {
        const found = find();
        if (found) return found;
        await setTimeout(50);
      }
      // One last look: a line may have arrived during the final wait.
      const found = find();
      if (found) return found;
      throw new Error(
        `No ${event} log line for trace ${traceId}. Last Worker output:\n${outputTail(worker?.lines ?? [])}`,
      );
    },
    navigate(path) {
      return new Promise((resolve, reject) => {
        const request = get(
          `${origin}${path}`,
          {
            headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
            // A deadline for the whole exchange, so a slow trickle cannot hang the run either.
            signal: AbortSignal.timeout(10_000),
          },
          (response) => {
            let body = "";
            response.on("error", reject);
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (body += chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                contentType: response.headers["content-type"] ?? "",
                body,
              }),
            );
          },
        );
        request.on("error", reject);
      });
    },
    async call(path, options = {}) {
      const method = options.method ?? "GET";
      const headers: Record<string, string> = {};
      const sentOrigin = options.origin === undefined ? testAppOrigin : options.origin;
      if (method !== "GET" && sentOrigin !== null) {
        headers["origin"] = sentOrigin;
      }
      if (options.as) headers[accessAssertionHeader] = await signAccessToken(key, options.as);
      if (options.body !== undefined) headers["content-type"] = "application/json";
      return fetch(`${origin}${path}`, {
        method,
        headers: { ...headers, ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    },
    async withPausedWorker(action) {
      if (!resumeWorker) throw new Error("Worker cannot resume");
      await worker?.dispose();
      try {
        return await action(state);
      } finally {
        await resumeWorker();
      }
    },
    logEntries: () => entries,
    stop: dispose,
  };
}

/**
 * The Worker's structured log entry in an output line, or null. Wrangler may put text before
 * the JSON (and prints its own non-JSON lines), so parsing starts at the first `{`.
 */
function parseLogEntry(line: string): Record<string, unknown> | null {
  const plain = stripVTControlCharacters(line);
  const jsonStart = plain.indexOf("{");
  if (jsonStart === -1) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(plain.slice(jsonStart));
  } catch {
    return null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  const fields = Object.fromEntries(Object.entries(entry));
  return typeof fields["event"] === "string" ? fields : null;
}

/** A distinct Access user per call, so tests never share data by accident. */
export function newUser(label: string): AccessUser {
  const id = crypto.randomUUID();
  return { subject: `test:${id}`, email: `${label}-${id.slice(0, 8)}@example.com` };
}
