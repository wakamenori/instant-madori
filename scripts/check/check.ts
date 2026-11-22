import { rustBuildTool } from "../shared/rust-build.ts";
import { machineSlots, withDockerSlot } from "../shared/docker-slots.ts";
import { access, glob } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { start, stop } from "../shared/processes.ts";
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

export async function runChecks(
  mode: "--fast" | "default" | "--full",
  crates: ReturnType<typeof serviceCrates>,
  run: (label: string, command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>,
  inDockerSlot: (stage: () => Promise<void>) => Promise<void>,
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
  const cargo = (label: string, ...commandArgs: string[]) =>
    run(label, tool.command, commandArgs, tool.env);
  const script = (label: string, path: string) => run(label, process.execPath, [path]);
  const format = () =>
    pnpm("Format service files", "exec", "prettier", "--write", ".", "--log-level", "warn");
  const rustFormat = () =>
    run("Format service Rust", "cargo", ["fmt", ...crates.flatMap((crate) => ["-p", crate.name])]);

  await format();
  await rustFormat();
  await pnpm("Generate Worker types", "--filter", "@madori/worker", "types");
  if (!base)
    await cargo(
      "Generate internal API contract",
      "run",
      "--locked",
      "-q",
      "-p",
      "madori-geometry-api",
      "--bin",
      "emit-typescript",
      "--",
      "packages/contracts/src/generated",
    );
  await script("Generate internal body validators", "scripts/generate/generate-geometry.ts");
  if (mode === "--full") {
    await script("Build Wasm bindings", "scripts/build/build-wasm.ts");
    await script("Viewer Wasm contents", "scripts/check/check-viewer-wasm.ts");
  } else {
    await access("crates/viewer/pkg/madori_viewer.d.ts").catch(() => {
      throw new Error("Wasm bindings are missing. Run pnpm setup first (or pnpm check --full).");
    });
  }
  try {
    await pnpm("Fix and lint TypeScript", "exec", "eslint", ".", "--fix", "--max-warnings", "0");
  } finally {
    await format();
  }
  await script("Resolved TypeScript import boundaries", "scripts/check/check-imports.ts");
  for (const project of [
    "packages/contracts",
    "apps/web",
    "apps/worker",
    "apps/worker/tests",
    "apps/worker/tests/rpc",
    "scripts",
    "scripts/check/r2-create-only",
    "metrics",
  ]) {
    await pnpm(`TypeScript types: ${project}`, "exec", "tsc", "-p", `${project}/tsconfig.json`);
  }
  await pnpm("Unused TypeScript code and dependencies", "exec", "knip");
  await run("Unused Rust dependencies", "mise", [
    "exec",
    "--",
    "cargo",
    "machete",
    ...crates.map((crate) => crate.dir),
  ]);
  await run("Dockerfile", "mise", ["exec", "--", "hadolint", "apps/geometry/Dockerfile"]);
  const e2eFiles: string[] = [];
  for await (const file of glob("apps/*/tests/**/*.e2e.ts")) e2eFiles.push(file);
  assertContainerE2eFiles(e2eFiles);
  await script("Upstream boundary", "scripts/check/check-layout.ts");
  await script("Migration immutability", "scripts/check/check-migrations.ts");
  await script("SQL connection state", "scripts/check/check-sql.ts");
  await script("Document paths", "scripts/check/check-doc-paths.ts");
  await script("Skill argument placeholders", "scripts/check/check-skill-arguments.ts");
  await script("Secret scan", "scripts/check/check-secrets.ts");

  if (!base) {
    const native = ["--workspace", "--all-targets"];
    const wasm = ["-p", "madori-viewer", "--target", "wasm32-unknown-unknown", "--all-targets"];
    for (const [label, target] of [
      ["native", native],
      ["Wasm", wasm],
    ] satisfies [string, string[]][]) {
      await cargo(
        `Fix Rust: ${label}`,
        "clippy",
        "--locked",
        ...target,
        "--no-deps",
        "--fix",
        "--allow-dirty",
        "--allow-staged",
      );
    }
    await rustFormat();
    for (const [label, target] of [
      ["native", native],
      ["Wasm", wasm],
    ] satisfies [string, string[]][]) {
      await cargo(
        `Clippy: ${label}`,
        "clippy",
        "--locked",
        ...target,
        "--no-deps",
        "--",
        "-D",
        "warnings",
      );
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
    await run("TypeScript tests", process.execPath, [
      ...nodeTestFlags(resultsDir, "typescript"),
      ...(base
        ? ["--test-skip-pattern=^Rust serialized optional responses are accepted by generated zod$"]
        : []),
      ...tests.sort(),
    ]);
    if (!base) await cargo("Rust tests", ...cargoTestFlags(resultsDir));
  }
  if (mode === "--full") {
    await pnpm("Build web", "--filter", "@madori/web", "build");
    await pnpm("Build Worker (dry run)", "--filter", "@madori/worker", "build");
    await cargo("Build geometry service", "build", "--locked", "-p", "madori-geometry");
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
    await inDockerSlot(async () => {
      await run("Container integration", process.execPath, [
        ...nodeTestFlags(resultsDir, "container"),
        "apps/worker/tests/container.e2e.ts",
      ]);
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
  ) {
    interruption.signal.throwIfAborted();
    console.log(`\n[check] ${label}`);
    const stepStarted = performance.now();
    const child = start(command, commandArgs, { env });
    active.add(child);
    const result = await child.finished;
    active.delete(child);
    interruption.signal.throwIfAborted();
    if (result.kind === "error") throw result.error;
    if (result.code !== 0) {
      throw new Error(`${label} failed (${result.signal ?? result.code ?? "unknown exit"})`);
    }
    console.log(`[check] ${label}: ${((performance.now() - stepStarted) / 1000).toFixed(1)}s`);
  }
  const crates = serviceCrates();

  try {
    await runChecks(
      mode,
      crates,
      run,
      (stage) =>
        withDockerSlot(
          machineSlots(),
          { purpose: "pnpm check --full", signal: interruption.signal },
          stage,
        ),
      undefined,
      args.includes("--rust"),
    );
    console.log(
      `\n[check] Passed (${mode}, ${((performance.now() - started) / 1000).toFixed(1)}s).`,
    );
  } finally {
    await stop([...active]);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
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
