import { mkdtemp, readFile, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { start } from "../shared/processes.ts";
import type { ProcessOutcome } from "../shared/processes.ts";

const maxAttempts = 3;
const settingsNotApplied =
  "The Worker version was deployed, but its Durable Object-managed Container application settings were not fully applied. Re-run the same `wrangler deploy` command to retry and finish deployment.";

type FailureReason =
  | "wrangler could not start"
  | "stopped by a signal"
  | "no command-failed entry"
  | "unreadable output file"
  | "another error";
type AttemptOutcome =
  { kind: "deployed" } | { kind: "settingsNotApplied" } | { kind: "failed"; reason: FailureReason };

const entrySchema = z.looseObject({ type: z.string() });
const commandFailedSchema = z.looseObject({
  type: z.literal("command-failed"),
  version: z.literal(1),
  message: z.string(),
});

function classifyAttempt(exit: ProcessOutcome, output: string | undefined): AttemptOutcome {
  if (exit.kind === "error") return { kind: "failed", reason: "wrangler could not start" };
  if (exit.code === 0) return { kind: "deployed" };
  if (exit.signal !== null || (exit.code ?? 0) >= 129)
    return { kind: "failed", reason: "stopped by a signal" };
  if (output === undefined) return { kind: "failed", reason: "no command-failed entry" };
  const messages: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { kind: "failed", reason: "unreadable output file" };
    }
    const entry = entrySchema.safeParse(parsed);
    if (!entry.success) return { kind: "failed", reason: "unreadable output file" };
    if (entry.data.type === "command-failed") {
      const failed = commandFailedSchema.safeParse(parsed);
      if (!failed.success) return { kind: "failed", reason: "unreadable output file" };
      messages.push(failed.data.message);
    }
  }
  if (messages.length === 0) return { kind: "failed", reason: "no command-failed entry" };
  if (exit.code === 1 && messages.length === 1 && messages[0] === settingsNotApplied)
    return { kind: "settingsNotApplied" };
  return { kind: "failed", reason: "another error" };
}

let child: ReturnType<typeof start>["child"] | undefined;
let interrupted: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    interrupted ??= signal;
    child?.kill(signal);
  });
}

async function runAttempt(outputPath: string): Promise<AttemptOutcome> {
  const run = start("wrangler", ["deploy", ...process.argv.slice(2)], {
    detached: false,
    env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputPath },
  });
  child = run.child;
  const exit = await run.finished;
  child = undefined;
  return classifyAttempt(exit, await readFile(outputPath, "utf8").catch(() => undefined));
}

async function deploy() {
  // Wrangler records --var values in its session entry. RUNNER_TEMP is cleared after the job
  // even after SIGKILL, while the macOS runner retains its system temporary directory.
  const directory = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), "madori-wrangler-deploy-"),
  );
  try {
    for (let attempt = 1; !interrupted; attempt++) {
      const outcome = await runAttempt(join(directory, `attempt-${attempt}.ndjson`));
      if (interrupted) break;
      switch (outcome.kind) {
        case "deployed":
          console.log(`wrangler deploy succeeded on attempt ${attempt} of ${maxAttempts}.`);
          return 0;
        case "failed":
          console.log(
            `wrangler deploy failed on attempt ${attempt} of ${maxAttempts} (${outcome.reason}); not running it again.`,
          );
          return 1;
        case "settingsNotApplied":
          if (attempt === maxAttempts) {
            console.log(
              `::error title=wrangler deploy::All ${maxAttempts} attempts deployed the Worker version but did not finish its Container application settings; giving up.`,
            );
            return 1;
          }
          console.log(
            `::warning title=wrangler deploy re-run::Attempt ${attempt} of ${maxAttempts} deployed the Worker version but did not finish its Container application settings; running wrangler deploy again (attempt ${attempt + 1} of ${maxAttempts}).`,
          );
      }
    }
    return 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await deploy();
} catch {
  console.error("wrangler deploy wrapper failed before finishing.");
  process.exitCode = 1;
}
if (interrupted) {
  console.log(`wrangler deploy interrupted by ${interrupted}; not running it again.`);
  process.exitCode = 128 + constants.signals[interrupted];
}
