import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { minimumFreeBytes, requireFreeDisk, withDockerSlot } from "../shared/docker-slots.ts";
import { runChecks, type CheckGates } from "./check.ts";
import { nodeTestFlags } from "./test-results.ts";

const ungated: CheckGates = { dockerStage: (stage) => stage(), rustStage: () => {} };

type Command = string[];
const modes = ["--fast", "default", "--full"] as const;
const eslintFix = (command: Command) => command.includes("eslint") && command.includes("--fix");
const prettierWrite = (command: Command) =>
  command.includes("prettier") && command.includes("--write");
const importBoundaries = (command: Command) => command.includes("scripts/check/check-imports.ts");
const typeCheck = (command: Command) => command.includes("tsc");

const wasmBindingsOnly = mkdtempSync(join(tmpdir(), "madori-check-"));
mkdirSync(join(wasmBindingsOnly, "crates/viewer/pkg"), { recursive: true });
writeFileSync(join(wasmBindingsOnly, "crates/viewer/pkg/madori_viewer.d.ts"), "");
const original = process.cwd();
process.chdir(wasmBindingsOnly);
const resultsDir = join(wasmBindingsOnly, "results");
after(() => {
  process.chdir(original);
  rmSync(wasmBindingsOnly, { recursive: true, force: true });
});

void test("import boundaries read TypeScript after ESLint fixes and formatting, before type checks", async () => {
  for (const mode of modes) {
    const commands: Command[] = [];
    const failure = new Error("step failed");
    await assert.rejects(
      runChecks(
        mode,
        [],
        (_label, command, args) => {
          const invoked = [command, ...args];
          commands.push(invoked);
          return typeCheck(invoked) ? Promise.reject(failure) : Promise.resolve();
        },
        ungated,
        resultsDir,
      ),
      (error) => error === failure,
    );
    const checked = commands.findIndex(importBoundaries);
    const fixed = commands.map(eslintFix).lastIndexOf(true);
    const shown = `${mode}:\n${commands.map((command) => command.join(" ")).join("\n")}`;
    assert(fixed >= 0 && checked > fixed, shown);
    assert(commands.slice(fixed + 1, checked).some(prettierWrite), shown);
  }
});

void test("each mode clears previous results before the first step and records each suite it runs", async () => {
  const e2e = "apps/worker/tests/container.e2e.ts";
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync(e2e, "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  for (const mode of modes) {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "container.jsonl"), "stale");
    const commands = new Map<string, string[]>();
    await runChecks(
      mode,
      [],
      (label, _command, args) => {
        if (!commands.size) assert.deepEqual(readdirSync(resultsDir), []);
        commands.set(label, args);
        return Promise.resolve();
      },
      ungated,
      resultsDir,
    );
    for (const [label, suite] of [
      ["TypeScript tests", "typescript"],
      ["Container integration", "container"],
    ] as const) {
      const args = commands.get(label);
      if (mode === "--fast" || (suite === "container" && mode !== "--full"))
        assert.equal(args, undefined);
      else {
        assert(args);
        assert(args.includes("--test-reporter=spec"));
        assert(args.includes("--test-reporter-destination=stdout"));
        assert(
          args.some(
            (flag) => flag.startsWith("--test-reporter=") && flag.endsWith("/test-results.ts"),
          ),
        );
        assert(args.includes("--test-reporter-destination=" + join(resultsDir, suite + ".jsonl")));
      }
    }
    assert.deepEqual(commands.get("GitHub workflows"), ["exec", "--", "actionlint"]);
    const rust = commands.get("Rust tests");
    if (mode === "--fast") assert.equal(rust, undefined);
    else {
      assert(rust);
      assert(rust.includes("--no-fail-fast"));
      assert(rust.some((flag) => flag.includes(join(resultsDir, "rust.jsonl"))));
    }
  }
});

void test("full checks hold one Docker slot across container integration and pruning", async () => {
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  for (const mode of modes) {
    const commands: string[] = [];
    await runChecks(
      mode,
      [],
      (label, _command, args) => {
        commands.push([label, ...args].join(" "));
        return Promise.resolve();
      },
      {
        ...ungated,
        dockerStage: async (stage) => {
          commands.push("enter");
          await stage();
          commands.push("exit");
        },
      },
      resultsDir,
    );
    const markers = commands.filter((command) => command === "enter" || command === "exit");
    if (mode !== "--full") {
      assert.deepEqual(markers, []);
      continue;
    }
    assert.deepEqual(markers, ["enter", "exit"]);
    const end = commands.indexOf("exit");
    assert.deepEqual(commands.slice(commands.indexOf("enter") + 1, end), [
      [
        "Container integration",
        ...nodeTestFlags(resultsDir, "container"),
        "apps/worker/tests/container.e2e.ts",
      ].join(" "),
      "Prune geometry service images scripts/dev/prune-images.ts",
      "Prune Docker build cache scripts/dev/prune-build-cache.ts",
    ]);
    assert.deepEqual(
      commands.slice(end + 1).map((line) => line.split(" ").slice(0, 3).join(" ")),
      ["JavaScript dependency licenses", "JavaScript vulnerability audit", "Rust dependency audit"],
    );
  }
});

void test("full checks fail when cargo deny finds a stale advisory ignore or an unused wrapper", async () => {
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  const audits: Command[] = [];
  const failure = new Error("cargo deny failed");
  await assert.rejects(
    runChecks(
      "--full",
      [],
      (_label, command, args) => {
        const invoked = [command, ...args];
        if (invoked.join(" ").includes("cargo deny")) {
          audits.push(invoked);
          return Promise.reject(failure);
        }
        return Promise.resolve();
      },
      ungated,
      resultsDir,
    ),
    (error) => error === failure,
    "pnpm check --full must fail when cargo deny fails",
  );
  assert.deepEqual(
    audits,
    [
      [
        "mise",
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
      ],
    ],
    "The two -D flags make a stale advisory ignore or an unused wrappers entry in deny.toml fail the audit. When cargo deny reports one, remove that entry from deny.toml instead of changing this command. See third_party/solidcraft.md.",
  );
});

void test("a second Ctrl-C lets check stop its running step", async () => {
  const directory = mkdtempSync(join(wasmBindingsOnly, "bin-"));
  const pidFile = join(directory, "pnpm.pid");
  writeFileSync(
    join(directory, "cargo"),
    `#!/bin/sh
[ -n "$RUSTUP_TOOLCHAIN" ] && exec "$RUSTUP_TOOLCHAIN/bin/cargo" "$@"
echo '{"packages":[],"workspace_members":[]}'
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "pnpm"),
    `#!${process.execPath}
import { writeFileSync, renameSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.env.STEP_PID + ".stopping", "");
  setTimeout(() => process.exit(0), 100);
});
writeFileSync(process.env.STEP_PID + ".tmp", String(process.pid));
renameSync(process.env.STEP_PID + ".tmp", process.env.STEP_PID);
setTimeout(() => process.exit(1), 10000);
`,
    { mode: 0o755 },
  );
  const check = spawn(
    process.execPath,
    [fileURLToPath(new URL("./check.ts", import.meta.url)), "--fast", "--rust"],
    {
      env: {
        ...process.env,
        PATH: directory + ":" + process.env["PATH"],
        STEP_PID: pidFile,
        RUSTUP_TOOLCHAIN: undefined,
        // The outer pnpm check is writing its own results while this test runs.
        MADORI_TEST_RESULTS_DIR: join(directory, "results"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      killSignal: "SIGKILL",
    },
  );
  const closed = once(check, "close");
  const stderr = text(check.stderr);
  check.stdout.resume();
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile)) {
      assert(
        check.exitCode === null && check.signalCode === null && Date.now() < deadline,
        "pnpm stub did not start",
      );
      await sleep(10);
    }
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert(existsSync(join(directory, "results")), "check used the given results directory");
    check.kill("SIGINT");
    while (!existsSync(pidFile + ".stopping")) {
      assert(Date.now() < deadline, "pnpm stub did not receive SIGTERM");
      await sleep(1);
    }
    check.kill("SIGINT");
    assert.deepEqual(await closed, [1, null]);
    assert.match(await stderr, /\[check\] Check interrupted/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    check.kill("SIGKILL");
    await closed;
  }
});

void test("default and full checks run the skill script tests; fast checks do not", async () => {
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  const skillTest = ".claude/skills/madori-coordinator/scripts/example.test.mjs";
  mkdirSync(".claude/skills/madori-coordinator/scripts", { recursive: true });
  writeFileSync(skillTest, "");
  for (const mode of modes) {
    let args: string[] | undefined;
    await runChecks(
      mode,
      [],
      (label, _command, commandArgs) => {
        if (label === "TypeScript tests") args = commandArgs;
        return Promise.resolve();
      },
      ungated,
      resultsDir,
    );
    if (mode === "--fast") assert.equal(args, undefined);
    else assert(args?.includes(skillTest), `${mode}: ${String(args)}`);
  }
});

void test("local change selection controls every Rust build and the mixed TypeScript suite", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "madori-rust-check-"));
  const previous = process.cwd();
  const ci = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  process.chdir(cwd);
  t.after(() => {
    if (ci === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = ci;
    process.chdir(previous);
    rmSync(cwd, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args]);
  mkdirSync("crates/viewer/pkg", { recursive: true });
  writeFileSync("crates/viewer/pkg/madori_viewer.d.ts", "");
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  async function verify(build: boolean, mode: "default" | "--full" = "default", force = false) {
    const gated: string[] = [];
    const commands = new Map<string, string[]>();
    await runChecks(
      mode,
      [],
      (label, _command, args) => {
        commands.set(label, args);
        return Promise.resolve();
      },
      { ...ungated, rustStage: (label) => gated.push(label) },
      resultsDir,
      force,
    );
    for (const label of [
      "Generate internal API contract",
      "Fix Rust: native",
      "Fix Rust: Wasm",
      "Clippy: native",
      "Clippy: Wasm",
      "Rust tests",
    ])
      assert.equal(commands.has(label), build, label);
    assert.equal(gated.includes("TypeScript tests"), build);
    const ts = commands.get("TypeScript tests");
    assert(ts);
    assert(ts.includes("apps/worker/tests/example.test.ts"));
    assert.equal(
      ts.some((arg) => arg.startsWith("--test-skip-pattern")),
      !build,
    );
    assert(commands.has("Format service Rust"));
    assert(commands.has("Unused Rust dependencies"));
  }
  await verify(true);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync("app.ts", "changed");
  await verify(false);
  await verify(true, "default", true);
  await verify(true, "--full");
  process.env.GITHUB_ACTIONS = "true";
  await verify(true);
  delete process.env.GITHUB_ACTIONS;
  writeFileSync("crates/new.rs", "");
  await verify(true);
});

void test("full checks gate every Rust build immediately before running it", async () => {
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  const steps: string[] = [];
  await runChecks(
    "--full",
    [],
    (label) => {
      steps.push(label);
      return Promise.resolve();
    },
    { ...ungated, rustStage: (label) => steps.push("gate " + label) },
    resultsDir,
    true,
  );
  const gated = steps.filter((step) => step.startsWith("gate ")).map((step) => step.slice(5));
  assert.deepEqual(gated, [
    "Generate internal API contract",
    "Build Wasm bindings",
    "Fix Rust: native",
    "Fix Rust: Wasm",
    "Clippy: native",
    "Clippy: Wasm",
    "TypeScript tests",
    "Rust tests",
    "Build geometry service",
  ]);
  for (const label of gated) assert.equal(steps[steps.indexOf("gate " + label) + 1], label);
});

void test("each mode stops before its first Rust build on low disk", async () => {
  const slots = {
    kind: "flock",
    directory: wasmBindingsOnly,
    pool: "development",
    freeBytes: () => minimumFreeBytes - 1,
  } as const;
  for (const mode of modes) {
    const steps: string[] = [];
    const lines: string[] = [];
    await assert.rejects(
      runChecks(
        mode,
        [],
        (label) => {
          steps.push(label);
          return Promise.resolve();
        },
        {
          ...ungated,
          rustStage: (label) => requireFreeDisk(slots, label, (line) => lines.push(line)),
        },
        resultsDir,
        true,
      ),
      /Not enough free disk space before Generate internal API contract/,
    );
    assert.deepEqual(steps, [
      "Format service files",
      "Format service Rust",
      "Generate Worker types",
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", / stopped before Generate internal API contract: 11\.9 GiB free/);
  }
});

void test("full checks stop before container integration and pruning when disk falls", async (t) => {
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  const directory = mkdtempSync(join(wasmBindingsOnly, "docker-"));
  const previousHome = process.env.INSTANT_MADORI_METRICS_HOME;
  process.env.INSTANT_MADORI_METRICS_HOME = directory;
  t.after(() => {
    if (previousHome === undefined) delete process.env.INSTANT_MADORI_METRICS_HOME;
    else process.env.INSTANT_MADORI_METRICS_HOME = previousHome;
  });
  let free = 100 * 1024 ** 3;
  const slots = { kind: "flock", directory, pool: "development", freeBytes: () => free } as const;
  const steps: string[] = [];
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  await assert.rejects(
    runChecks(
      "--full",
      [],
      (label) => {
        steps.push(label);
        if (label === "Build staging Worker (dry run)") free = minimumFreeBytes - 1;
        return Promise.resolve();
      },
      {
        dockerStage: (stage) =>
          withDockerSlot(
            slots,
            { purpose: "pnpm check --full", signal: new AbortController().signal, log },
            stage,
          ),
        rustStage: (label) => requireFreeDisk(slots, label, log),
      },
      resultsDir,
      true,
    ),
    /Not enough free disk space before taking/,
  );
  assert.equal(steps.at(-1), "Build staging Worker (dry run)");
  for (const skipped of [
    "Container integration",
    "Prune geometry service images",
    "Prune Docker build cache",
    "JavaScript dependency licenses",
  ])
    assert(!steps.includes(skipped));
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] ?? "",
    / stopped before taking a development slot for pnpm check --full: 11\.9 GiB free/,
  );
});

void test("rejects a foreign cargo before starting work", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "foreign-cargo-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "calls");
  writeFileSync(
    join(directory, "cargo"),
    '#!/bin/sh\necho "$@" >> "$LOG"\necho "cargo 1.100.0 (Homebrew)"\n',
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check.ts", import.meta.url)), "--fast"],
    {
      encoding: "utf8",
      env: {
        PATH: directory + ":/usr/bin:/bin",
        HOME: directory,
        CARGO_HOME: directory,
        TMPDIR: directory,
        LOG: log,
      },
    },
  );
  assert.equal(result.status, 1);
  assert(result.stderr.includes("[rustup] cargo on PATH is"), result.stderr);
  assert(!result.stdout.includes("[check] Format service files"));
  assert.equal(readFileSync(log, "utf8"), "--version\n");
});

void test("shows usage without cargo", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "check-help-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check.ts", import.meta.url)), "--help"],
    {
      encoding: "utf8",
      env: { PATH: directory, HOME: directory, TMPDIR: directory, CARGO_HOME: directory },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: pnpm check/u);
});
