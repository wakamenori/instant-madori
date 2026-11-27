import { checkRustupCargo } from "../shared/rustup-cargo.ts";
import { rustBuildTool } from "../shared/rust-build.ts";
import { machineSlots, requireFreeDisk, withDockerSlot } from "../shared/docker-slots.ts";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { access, glob, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { start, stop, type ProcessOutcome } from "../shared/processes.ts";
import { repositoryRoot, serviceCrates } from "../shared/repository.ts";
import { assertContainerE2eFiles } from "./layout-contract.ts";
import { rustSkipBase } from "./rust-inputs.ts";
import { cargoTestFlags, nodeTestFlags, resetResults } from "./test-results.ts";

const usage = `Usage: pnpm check [--fast | --full] [--rust]
  --fast  Autofix, TypeScript types/lint, Rust native/Wasm Clippy, local static checks.
  default All fast checks, TypeScript tests and Rust tests.
  --rust  Run the Rust build steps for this mode even if Rust inputs are unchanged.
  --full  Also rebuild Wasm bindings, build apps, check local integration and audit dependencies.
All modes modify service source through formatters and automatic lint fixes.
Run pnpm setup once before checking. No mode stages files or deploys resources.`;

const cacheDirectory = "node_modules/.cache/madori-check";
const prettierCacheFlags = [
  "--cache",
  "--cache-strategy",
  "content",
  "--cache-location",
  `${cacheDirectory}/prettier`,
];
const eslintArgs = ["exec", "eslint", ".", "--fix", "--max-warnings", "0"];

function lintInputDigest(): string {
  const digest = createHash("sha256").update(JSON.stringify([1, process.version, eslintArgs]));
  function add(path: string, kind: "file" | "link", bytes: Buffer) {
    digest.update(JSON.stringify([path, kind, bytes.length])).update(bytes);
  }
  const skippedDirectories = new Set([".git", "node_modules", "target", ".tools", ".wrangler"]);
  function walk(directory: string) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : Number(a.name > b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name) && path !== join(".claude", "worktrees"))
          walk(path);
      } else if (entry.isSymbolicLink()) {
        add(path, "link", readlinkSync(path, { encoding: "buffer" }));
      } else if (entry.isFile() && /\.(?:[cm]?ts|[cm]?js|tsx|jsx|jsonc?)$/.test(entry.name)) {
        add(path, "file", readFileSync(path));
      }
    }
  }
  walk(".");
  for (const path of [
    "pnpm-lock.yaml",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
  ]) {
    if (existsSync(path)) add(path, "file", readFileSync(path));
  }
  return digest.digest("hex");
}

function eslintCacheFlags(): string[] {
  const filename = `eslint-${lintInputDigest()}.json`;
  if (lstatSync(cacheDirectory, { throwIfNoEntry: false })) {
    for (const entry of readdirSync(cacheDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() && /^eslint-.*\.json$/.test(entry.name) && entry.name !== filename)
        rmSync(join(cacheDirectory, entry.name), { force: true });
    }
  }
  return [
    "--cache",
    "--cache-strategy",
    "content",
    "--cache-location",
    `${cacheDirectory}/${filename}`,
  ];
}

export class StepFailed extends Error {
  constructor(label: string, status: string) {
    super(`${label} failed (${status})`);
  }
}

class StaticStepsFailed extends Error {}

function assertStaticStepsSucceeded(failures: Error[]) {
  const [first] = failures;
  if (!first) return;
  if (failures.length === 1) throw first;
  throw new StaticStepsFailed(failures.map((failure) => failure.message).join("; "));
}

export async function runGroup(tasks: readonly (() => Promise<void>)[], limit: number) {
  const failed = new Map<number, StepFailed>();
  const fatal: { index: number; error: unknown }[] = [];
  let next = 0;
  async function work() {
    while (fatal.length === 0) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      try {
        await task();
      } catch (error) {
        if (error instanceof StepFailed) failed.set(index, error);
        else fatal.push({ index, error });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, work));
  const [firstFatal] = fatal.sort((a, b) => a.index - b.index);
  if (firstFatal) throw firstFatal.error;
  assertStaticStepsSucceeded([...failed].sort(([a], [b]) => a - b).map(([, error]) => error));
}

function staticConcurrency(): number {
  return Math.min(6, Math.max(2, Math.floor(availableParallelism() / 2)));
}

export function assertStepSucceeded(label: string, outcome: ProcessOutcome): void {
  if (outcome.kind === "error") throw outcome.error;
  if (outcome.code !== 0) {
    throw new StepFailed(label, String(outcome.signal ?? outcome.code ?? "unknown exit"));
  }
}

type StepOutput = "inherit" | "capture";
type RunStep = (
  label: string,
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  output?: StepOutput,
) => Promise<void>;

export type CheckGates = {
  dockerStage: (stage: () => Promise<void>) => Promise<void>;
  rustStage: (label: string) => void;
};

export async function runChecks(
  mode: "--fast" | "default" | "--full",
  crates: ReturnType<typeof serviceCrates>,
  run: RunStep,
  gates: CheckGates,
  resultsDir = resolve(process.env.MADORI_TEST_RESULTS_DIR ?? "target/test-results"),
  forceRust = false,
): Promise<void> {
  const base = rustSkipBase(
    process.cwd(),
    forceRust || mode === "--full",
    process.env.GITHUB_ACTIONS,
  );
  if (base)
    console.log(
      `[check] Rust steps skipped: no Rust inputs changed since ${base.slice(0, 12)} (CI runs them)`,
    );
  await resetResults(resultsDir);
  const pnpm = (label: string, ...commandArgs: string[]) => run(label, "pnpm", commandArgs);
  const tool = rustBuildTool();
  const cargo = (label: string, commandArgs: string[], output?: StepOutput) => {
    gates.rustStage(label);
    return run(label, tool.command, commandArgs, tool.env, output);
  };
  const script = (label: string, path: string, output?: StepOutput) =>
    run(label, process.execPath, [path], undefined, output);
  const format = () =>
    pnpm(
      "Format service files",
      "exec",
      "prettier",
      "--write",
      ".",
      "--log-level",
      "warn",
      ...prettierCacheFlags,
    );
  const rustFormat = () =>
    run("Format service Rust", "cargo", ["fmt", ...crates.flatMap((crate) => ["-p", crate.name])]);

  await format();
  await rustFormat();
  await pnpm("Generate Worker types", "--filter", "@madori/worker", "types");
  if (!base)
    await cargo("Generate internal API contract", [
      "run",
      "--locked",
      "-q",
      "-p",
      "madori-geometry-api",
      "--bin",
      "emit-typescript",
      "--",
      "packages/contracts/src/generated",
    ]);
  await script("Generate internal body validators", "scripts/generate/generate-geometry.ts");
  if (mode === "--full") {
    gates.rustStage("Build Wasm bindings");
    await script("Build Wasm bindings", "scripts/build/build-wasm.ts");
    await script("Viewer Wasm contents", "scripts/check/check-viewer-wasm.ts");
    await script("Viewer Wasm size", "scripts/check/check-viewer-wasm-size.ts");
  } else {
    await access("crates/viewer/pkg/madori_viewer.d.ts").catch(() => {
      throw new Error("Wasm bindings are missing. Run pnpm setup first (or pnpm check --full).");
    });
  }
  const ci = process.env.GITHUB_ACTIONS !== undefined;
  try {
    await pnpm("Fix and lint TypeScript", ...eslintArgs, ...(ci ? [] : eslintCacheFlags()));
  } finally {
    await format();
  }

  const e2eFiles: string[] = [];
  for await (const file of glob("apps/*/tests/**/*.e2e.ts")) e2eFiles.push(file);
  assertContainerE2eFiles(e2eFiles);

  const projects = [
    "apps/worker/tests/rpc",
    "scripts",
    "apps/worker",
    "apps/worker/tests",
    "apps/web",
    "metrics",
    "packages/contracts",
    "scripts/check/r2-create-only",
  ];
  const staticTasks = projects.map(
    (project) => () =>
      run(
        `TypeScript types: ${project}`,
        "pnpm",
        ["exec", "tsc", "-p", `${project}/tsconfig.json`],
        undefined,
        "capture",
      ),
  );
  staticTasks.push(() =>
    run("Unused TypeScript code and dependencies", "pnpm", ["exec", "knip"], undefined, "capture"),
  );
  for (const [label, path] of [
    ["Upstream boundary", "scripts/check/check-layout.ts"],
    ["Resolved TypeScript import boundaries", "scripts/check/check-imports.ts"],
    ["Secret scan", "scripts/check/check-secrets.ts"],
    ["SQL connection state", "scripts/check/check-sql.ts"],
    ["Migration immutability", "scripts/check/check-migrations.ts"],
  ] as const) {
    staticTasks.push(() => script(label, path, "capture"));
  }
  for (const [label, commandArgs] of [
    ["Unused Rust dependencies", ["cargo", "machete", ...crates.map((crate) => crate.dir)]],
    ["Dockerfile", ["hadolint", "apps/geometry/Dockerfile"]],
    ["GitHub workflows", ["actionlint"]],
  ] as const) {
    staticTasks.push(() =>
      run(label, "mise", ["exec", "--", ...commandArgs], undefined, "capture"),
    );
  }
  staticTasks.push(
    () => script("Document paths", "scripts/check/check-doc-paths.ts", "capture"),
    () =>
      script("Skill argument placeholders", "scripts/check/check-skill-arguments.ts", "capture"),
  );

  const clippyTargets = [
    { label: "native", args: ["--workspace", "--all-targets"] },
    {
      label: "Wasm",
      args: ["-p", "madori-viewer", "--target", "wasm32-unknown-unknown", "--all-targets"],
    },
  ];
  type ClippyTarget = (typeof clippyTargets)[number];
  const failedClippy: { target: ClippyTarget; error: StepFailed }[] = [];
  const clippy = ({ label, args }: ClippyTarget, output?: StepOutput) =>
    cargo(
      `Clippy: ${label}`,
      ["clippy", "--locked", ...args, "--no-deps", "--", "-D", "warnings"],
      output,
    );
  if (!base) {
    staticTasks.unshift(async () => {
      for (const target of clippyTargets) {
        try {
          await clippy(target, "capture");
        } catch (error) {
          if (ci || !(error instanceof StepFailed)) throw error;
          failedClippy.push({ target, error });
        }
      }
    });
  }
  try {
    await runGroup(staticTasks, staticConcurrency());
  } catch (error) {
    if (error instanceof StepFailed || error instanceof StaticStepsFailed)
      assertStaticStepsSucceeded([error, ...failedClippy.map((failure) => failure.error)]);
    throw error;
  }
  if (failedClippy.length > 0) {
    for (const { target } of failedClippy) {
      await cargo(`Fix Rust: ${target.label}`, [
        "clippy",
        "--locked",
        ...target.args,
        "--no-deps",
        "--fix",
        "--allow-dirty",
        "--allow-staged",
      ]);
    }
    await rustFormat();
    for (const target of clippyTargets) await clippy(target);
  }

  const failedTests: StepFailed[] = [];
  async function deferTestFailure(stage: Promise<void>) {
    try {
      await stage;
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      failedTests.push(error);
      console.error(`[check] ${error.message}. The remaining steps still run, then check fails.`);
    }
  }

  if (mode !== "--fast") {
    const tests: string[] = [];
    for await (const path of glob([
      "apps/*/{src,tests}/**/*.test.ts",
      "packages/*/{src,tests}/**/*.test.ts",
      "scripts/**/*.test.ts",
      "metrics/**/*.test.ts",
      ".claude/skills/*/scripts/*.test.mjs",
    ]))
      tests.push(path);
    if (tests.length === 0) throw new Error("No TypeScript tests found");
    if (!base) gates.rustStage("TypeScript tests");
    await deferTestFailure(
      run("TypeScript tests", process.execPath, [
        ...nodeTestFlags(resultsDir, "typescript"),
        ...(base
          ? [
              "--test-skip-pattern=^Rust serialized optional responses are accepted by generated zod$",
            ]
          : []),
        ...tests.sort(),
      ]),
    );
    if (!base) await deferTestFailure(cargo("Rust tests", cargoTestFlags(resultsDir)));
  }
  if (mode === "--full") {
    await pnpm("Build web", "--filter", "@madori/web", "build");
    await pnpm("Build Worker (dry run)", "--filter", "@madori/worker", "build");
    await cargo("Build geometry service", ["build", "--locked", "-p", "madori-geometry"]);
    await script("Local integration", "scripts/check/smoke.ts");
    await pnpm(
      "Build staging Worker (dry run)",
      "--filter",
      "@madori/worker",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--env",
      "staging",
      "--containers-rollout=none",
    );
    await gates.dockerStage(async () => {
      await deferTestFailure(
        run("Container integration", process.execPath, [
          ...nodeTestFlags(resultsDir, "container"),
          "apps/worker/tests/container.e2e.ts",
        ]),
      );
      await script("Prune geometry service images", "scripts/dev/prune-images.ts");
      await script("Prune Docker build cache", "scripts/dev/prune-build-cache.ts");
    });
    await script("JavaScript dependency licenses", "scripts/check/check-licenses.ts");
    await pnpm("JavaScript vulnerability audit", "audit", "--audit-level", "low");
    await run("Rust dependency audit", "mise", [
      "exec",
      "--",
      "cargo",
      "deny",
      "--locked",
      "check",
      "-D",
      "advisory-not-detected",
      "-D",
      "unused-wrapper",
    ]);
  }
  if (failedTests.length > 0)
    throw new Error(failedTests.map((failure) => failure.message).join("; "));
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  const modes = args.filter((arg) => arg !== "--rust");
  if (modes.length > 1 || (modes.length === 1 && modes[0] !== "--fast" && modes[0] !== "--full")) {
    throw new Error(usage);
  }
  const mode = modes[0] === "--fast" || modes[0] === "--full" ? modes[0] : "default";
  process.chdir(fileURLToPath(repositoryRoot));
  if (!checkRustupCargo()) return;

  const logDirectory = mkdtempSync(join(tmpdir(), "madori-check-logs-"));
  let nextLog = 0;
  const active = new Set<ReturnType<typeof start>>();
  const interruption = new AbortController();
  function interrupt() {
    if (interruption.signal.aborted) return;
    interruption.abort(new Error("Check interrupted"));
    void stop([...active]).catch((error: unknown) => console.error(error));
  }
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const started = performance.now();

  async function run(
    label: string,
    command: string,
    commandArgs: string[],
    env?: NodeJS.ProcessEnv,
    output: StepOutput = "inherit",
  ) {
    interruption.signal.throwIfAborted();
    const log = output === "capture" ? join(logDirectory, String(nextLog++)) : undefined;
    if (!log) console.log(`\n[check] ${label}`);
    const stepStarted = performance.now();
    const fd = log ? openSync(log, "wx") : undefined;
    let child: ReturnType<typeof start>;
    try {
      child = start(
        command,
        commandArgs,
        fd === undefined ? { env } : { env, stdio: ["ignore", fd, fd] },
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    active.add(child);
    const result = await child.finished;
    active.delete(child);
    const duration = `${((performance.now() - stepStarted) / 1000).toFixed(1)}s`;
    if (log) {
      const contents = readFileSync(log, "utf8");
      const status = interruption.signal.aborted
        ? `${label} interrupted`
        : result.kind === "exit" && result.code === 0
          ? `${label}: ${duration}`
          : `${label} failed (${result.kind === "error" ? result.error.message : (result.signal ?? result.code ?? "unknown exit")}) after ${duration}`;
      const newline = contents && !contents.endsWith("\n") ? "\n" : "";
      process.stdout.write(`\n[check] ${label}\n${contents}${newline}[check] ${status}\n`);
    }
    interruption.signal.throwIfAborted();
    assertStepSucceeded(label, result);
    if (!log) console.log(`[check] ${label}: ${duration}`);
  }

  try {
    const crates = serviceCrates();
    const slots = machineSlots();
    await runChecks(
      mode,
      crates,
      run,
      {
        dockerStage: (stage) =>
          withDockerSlot(
            slots,
            { purpose: "pnpm check --full", signal: interruption.signal },
            stage,
          ),
        rustStage: (label) => requireFreeDisk(slots, label),
      },
      undefined,
      args.includes("--rust"),
    );
    console.log(
      `\n[check] Passed (${mode}, ${((performance.now() - started) / 1000).toFixed(1)}s).`,
    );
  } finally {
    try {
      await stop([...active]);
    } finally {
      try {
        await rm(logDirectory, { recursive: true });
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`\n[check] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
