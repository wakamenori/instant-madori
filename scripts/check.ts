import { access, glob } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { start, stop } from "./processes.ts";

const usage = `Usage: pnpm check [--fast | --full]
  --fast  Autofix, TypeScript types/lint, Rust native/Wasm Clippy, local static checks.
  default All fast checks, TypeScript tests and Rust tests.
  --full  Also rebuild Wasm bindings, build apps, check local integration and audit dependencies.
All modes modify service source through formatters and automatic lint fixes.
Run pnpm setup once before checking. No mode stages files or deploys resources.`;

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--fast" && args[0] !== "--full")) {
    throw new Error(usage);
  }
  const mode = args[0] ?? "default";
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));

  const active = new Set<ReturnType<typeof start>>();
  let interrupted = false;
  function interrupt() {
    interrupted = true;
    void stop([...active]).catch((error: unknown) => console.error(error));
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const started = performance.now();

  async function run(label: string, command: string, commandArgs: string[]) {
    if (interrupted) throw new Error("Check interrupted");
    console.log(`\n[check] ${label}`);
    const stepStarted = performance.now();
    const child = start(command, commandArgs);
    active.add(child);
    const result = await child.finished;
    active.delete(child);
    if (interrupted) throw new Error("Check interrupted");
    if (result.kind === "error") throw result.error;
    if (result.code !== 0) {
      throw new Error(`${label} failed (${result.signal ?? result.code ?? "unknown exit"})`);
    }
    console.log(`[check] ${label}: ${((performance.now() - stepStarted) / 1000).toFixed(1)}s`);
  }
  const pnpm = (label: string, ...commandArgs: string[]) => run(label, "pnpm", commandArgs);
  const cargo = (label: string, ...commandArgs: string[]) => run(label, "cargo", commandArgs);
  const script = (label: string, path: string) => run(label, process.execPath, [path]);
  const format = () =>
    pnpm("Format service files", "exec", "prettier", "--write", ".", "--log-level", "warn");
  const rustFormat = () =>
    cargo(
      "Format service Rust",
      "fmt",
      "-p",
      "madori-geometry",
      "-p",
      "madori-housing",
      "-p",
      "madori-modeling",
      "-p",
      "madori-viewer",
    );

  try {
    await format();
    await rustFormat();
    await pnpm("Generate Worker types", "--filter", "@madori/worker", "types");
    if (mode === "--full") {
      await script("Build Wasm bindings", "scripts/build-wasm.ts");
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
    for (const project of [
      "packages/contracts",
      "apps/web",
      "apps/worker",
      "apps/worker/tests",
      "scripts",
    ]) {
      await pnpm(`TypeScript types: ${project}`, "exec", "tsc", "-p", `${project}/tsconfig.json`);
    }
    await pnpm("Unused TypeScript code and dependencies", "exec", "knip");
    await run("Unused Rust dependencies", "mise", [
      "exec",
      "--",
      "cargo",
      "machete",
      "apps/geometry",
      "crates/housing",
      "crates/modeling",
      "crates/viewer",
    ]);
    await run("Dockerfile", "mise", ["exec", "--", "hadolint", "apps/geometry/Dockerfile"]);
    await script("Upstream boundary", "scripts/check-layout.ts");
    await script("Secret scan", "scripts/check-secrets.ts");

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

    if (mode !== "--fast") {
      const tests: string[] = [];
      for await (const path of glob([
        "apps/*/{src,tests}/**/*.test.ts",
        "packages/*/{src,tests}/**/*.test.ts",
        "scripts/**/*.test.ts",
      ]))
        tests.push(path);
      if (tests.length === 0) throw new Error("No TypeScript tests found");
      await run("TypeScript tests", process.execPath, [
        "--test",
        "--test-reporter=spec",
        ...tests.sort(),
      ]);
      await cargo("Rust tests", "test", "--locked", "--workspace");
    }
    if (mode === "--full") {
      await pnpm("Build web", "--filter", "@madori/web", "build");
      await pnpm("Build Worker (dry run)", "--filter", "@madori/worker", "build");
      await cargo("Build geometry service", "build", "--locked", "-p", "madori-geometry");
      await script("Local integration", "scripts/smoke.ts");
      await script("JavaScript dependency licenses", "scripts/check-licenses.ts");
      await pnpm("JavaScript vulnerability audit", "audit", "--audit-level", "low");
      await run("Rust dependency audit", "mise", [
        "exec",
        "--",
        "cargo",
        "deny",
        "--locked",
        "check",
      ]);
    }
    console.log(
      `\n[check] Passed (${mode}, ${((performance.now() - started) / 1000).toFixed(1)}s).`,
    );
  } finally {
    await stop([...active]);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n[check] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
