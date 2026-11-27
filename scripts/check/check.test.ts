import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";
import { minimumFreeBytes, requireFreeDisk, withDockerSlot } from "../shared/docker-slots.ts";
import { assertStepSucceeded, runChecks, runGroup, StepFailed, type CheckGates } from "./check.ts";
import { nodeTestFlags, type TestResult } from "./test-results.ts";

const ungated: CheckGates = { dockerStage: (stage) => stage(), rustStage: () => {} };
const wireLabel = "TypeScript tests (Rust wire fixture)";
const wirePath = "scripts/generate/geometry-schema.test.ts";
const wireName = "Rust serialized optional responses are accepted by generated zod";
const wireId = `${wirePath} > ${wireName}`;

function writeTestRecords(args: string[], records: TestResult[]) {
  const prefix = "--test-reporter-destination=";
  const destination = args.find((arg) => arg.startsWith(prefix) && arg.endsWith(".jsonl"));
  assert(destination);
  writeFileSync(
    destination.slice(prefix.length),
    records.map((record) => JSON.stringify(record) + "\n").join(""),
  );
}

type Command = string[];
const modes = ["--fast", "default", "--full"] as const;
const eslintFix = (command: Command) => command.includes("eslint") && command.includes("--fix");
const prettierWrite = (command: Command) =>
  command.includes("prettier") && command.includes("--write");
const importBoundaries = (command: Command) => command.includes("scripts/check/check-imports.ts");

const wasmBindingsOnly = mkdtempSync(join(tmpdir(), "madori-check-"));
mkdirSync(join(wasmBindingsOnly, "crates/viewer/pkg"), { recursive: true });
writeFileSync(join(wasmBindingsOnly, "crates/viewer/pkg/madori_viewer.d.ts"), "");
mkdirSync(join(wasmBindingsOnly, "apps/worker/tests"), { recursive: true });
writeFileSync(join(wasmBindingsOnly, "apps/worker/tests/container.e2e.ts"), "");
const original = process.cwd();
process.chdir(wasmBindingsOnly);
const resultsDir = join(wasmBindingsOnly, "results");
after(() => {
  process.chdir(original);
  rmSync(wasmBindingsOnly, { recursive: true, force: true });
});

void test("import boundaries read TypeScript after ESLint fixes and formatting", async () => {
  for (const mode of modes) {
    const commands: Command[] = [];
    const failure = new StepFailed("TypeScript types: packages/contracts", "1");
    await assert.rejects(
      runChecks(
        mode,
        [],
        (label, command, args) => {
          const invoked = [command, ...args];
          commands.push(invoked);
          return label === "TypeScript types: packages/contracts"
            ? Promise.reject(failure)
            : Promise.resolve();
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
    const labels = [...commands.keys()];
    if (mode === "--full") {
      const contents = labels.indexOf("Viewer Wasm contents");
      assert(contents >= 0);
      assert.equal(labels[contents + 1], "Viewer Wasm size");
      assert.deepEqual(commands.get("Viewer Wasm size"), [
        "scripts/check/check-viewer-wasm-size.ts",
      ]);
    } else assert(!commands.has("Viewer Wasm size"));
    const rust = commands.get("Rust tests");
    if (mode === "--fast") assert.equal(rust, undefined);
    else {
      assert(rust);
      assert(rust.includes("--no-fail-fast"));
      assert(rust.some((flag) => flag.includes(join(resultsDir, "rust.jsonl"))));
    }
  }
});

function runTestStages(
  mode: "default" | "--full",
  steps: string[],
  failures: Record<string, Error> = {},
  gates = ungated,
) {
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  writeFileSync("apps/worker/tests/example.test.ts", "");
  return runChecks(
    mode,
    [],
    (label) => {
      steps.push(label);
      const failure = failures[label];
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
    gates,
    resultsDir,
    true,
  );
}

void test("a TypeScript test failure lets the remaining checks run", async (t) => {
  const notices = t.mock.method(console, "error", () => {});
  const passed: string[] = [];
  await runTestStages("--full", passed);
  for (const mode of ["default", "--full"] as const) {
    notices.mock.resetCalls();
    const steps: string[] = [];
    await assert.rejects(
      runTestStages(mode, steps, {
        "TypeScript tests": new StepFailed("TypeScript tests", "1"),
      }),
      { message: "TypeScript tests failed (1)" },
    );
    assert.deepEqual(
      notices.mock.calls.map((call) => call.arguments),
      [["[check] TypeScript tests failed (1). The remaining steps still run, then check fails."]],
    );
    assert(steps.includes("Rust tests"));
    if (mode === "--full") {
      assert.deepEqual(
        steps.slice(steps.indexOf("TypeScript tests") + 1),
        passed.slice(passed.indexOf("TypeScript tests") + 1),
      );
    }
  }
});

void test("full checks report all failed test stages in order after pruning and audits", async (t) => {
  t.mock.method(console, "error", () => {});
  const steps: string[] = [];
  await assert.rejects(
    runTestStages("--full", steps, {
      "TypeScript tests": new StepFailed("TypeScript tests", "1"),
      "Rust tests": new StepFailed("Rust tests", "101"),
      "Container integration": new StepFailed("Container integration", "1"),
    }),
    {
      message:
        "TypeScript tests failed (1); Rust tests failed (101); Container integration failed (1)",
    },
  );
  assert.deepEqual(steps.slice(steps.indexOf("Container integration") + 1), [
    "Prune geometry service images",
    "Prune Docker build cache",
    "JavaScript dependency licenses",
    "JavaScript vulnerability audit",
    "Rust dependency audit",
  ]);
});

void test("a build failure stops full checks after a failed test stage", async (t) => {
  t.mock.method(console, "error", () => {});
  const steps: string[] = [];
  const failure = new StepFailed("Build web", "1");
  await assert.rejects(
    runTestStages("--full", steps, {
      "TypeScript tests": new StepFailed("TypeScript tests", "1"),
      "Build web": failure,
    }),
    (error) => error === failure,
  );
  assert(!steps.includes("Container integration"));
});

void test("a fatal test-stage error stops checks before Rust tests run", async (t) => {
  t.mock.method(console, "error", () => {});
  const diskError = new Error("low disk");
  const steps: string[] = [];
  await assert.rejects(
    runTestStages(
      "default",
      steps,
      { "TypeScript tests": new StepFailed("TypeScript tests", "1") },
      {
        ...ungated,
        rustStage(label: string) {
          if (label === "Rust tests") throw diskError;
        },
      },
    ),
    (error) => error === diskError,
  );
  assert.deepEqual(steps.slice(steps.indexOf("TypeScript tests")), ["TypeScript tests"]);
});

void test(
  "a fatal TypeScript test error lets running Rust tests finish and starts nothing after them",
  { timeout: 5_000 },
  async () => {
    const rustStarted = deferred();
    const releaseRust = deferred();
    const spawnError = new Error("could not start tests");
    const steps: string[] = [];
    let settled = false;
    const done = assert
      .rejects(
        runChecks(
          "--full",
          [],
          async (label) => {
            steps.push(label);
            if (label === "TypeScript tests") {
              await rustStarted.promise;
              throw spawnError;
            }
            if (label === "Rust tests") {
              rustStarted.resolve();
              await releaseRust.promise;
            }
          },
          ungated,
          resultsDir,
          true,
        ),
        (error) => error === spawnError,
      )
      .then(() => {
        settled = true;
      });
    await rustStarted.promise;
    await sleep(0);
    try {
      assert(!settled);
    } finally {
      releaseRust.resolve();
      await done;
    }
    assert.deepEqual(steps.slice(steps.indexOf("TypeScript tests")), [
      "TypeScript tests",
      "Rust tests",
    ]);
    assert(!readdirSync(wasmBindingsOnly).some((path) => path.startsWith("madori-rust-wire-")));
  },
);

void test(
  "TypeScript and Rust tests overlap and keep late TypeScript records when the wire fixture finishes first",
  { timeout: 5_000 },
  async (t) => {
    t.mock.method(console, "error", () => {});
    const rustStarted = deferred();
    const wireFinished = deferred();
    const mainId = `${wirePath} > tracked zod bodies match the Rust JSON schemas`;
    const steps: string[] = [];
    await assert.rejects(
      runChecks(
        "default",
        [],
        async (label, _command, args, _env, output) => {
          if (label === "TypeScript tests") {
            steps.push("TypeScript started");
            assert.equal(output, "capture");
            await rustStarted.promise;
            await wireFinished.promise;
            await sleep(20);
            writeTestRecords(args, [
              { id: mainId, outcome: "pass" },
              { id: wirePath, outcome: "pass" },
            ]);
            steps.push("TypeScript ended");
            throw new StepFailed(label, "1");
          }
          if (label === "Rust tests") {
            assert.equal(output, "capture");
            steps.push("Rust started");
            rustStarted.resolve();
            await sleep(0);
            steps.push("Rust ended");
            throw new StepFailed(label, "101");
          }
          if (label === wireLabel) {
            assert.equal(output, "capture");
            assert.equal(args.at(-1), wirePath);
            assert(args.includes(`--test-name-pattern=^${wireName}$`));
            steps.push("Wire ran");
            writeTestRecords(args, [
              { id: wireId, outcome: "pass" },
              { id: wirePath, outcome: "fail" },
            ]);
            wireFinished.resolve();
          }
        },
        ungated,
        resultsDir,
        true,
      ),
      { message: "TypeScript tests failed (1); Rust tests failed (101)" },
    );
    assert.deepEqual(steps, [
      "TypeScript started",
      "Rust started",
      "Rust ended",
      "Wire ran",
      "TypeScript ended",
    ]);
    assert.deepEqual(readdirSync(resultsDir), ["typescript.jsonl"]);
    assert.equal(
      readFileSync(join(resultsDir, "typescript.jsonl"), "utf8"),
      [
        { id: mainId, outcome: "pass" },
        { id: wirePath, outcome: "fail" },
        { id: wireId, outcome: "pass" },
      ]
        .map((record) => JSON.stringify(record) + "\n")
        .join(""),
    );
    assert(!readdirSync(wasmBindingsOnly).some((path) => path.startsWith("madori-rust-wire-")));
  },
);

void test("the Rust wire fixture names a test that its file declares", () => {
  const source = readFileSync(new URL(`../../${wirePath}`, import.meta.url), "utf8");
  assert(
    source.includes(`test(${JSON.stringify(wireName)}`),
    `${wirePath} has no test named ${JSON.stringify(wireName)}; rename the wire fixture in check.ts with it`,
  );
});

void test("step outcomes distinguish unsuccessful exits from spawn errors", () => {
  assertStepSucceeded("stage", { kind: "exit", code: 0, signal: null });
  for (const [code, signal, message] of [
    [1, null, "stage failed (1)"],
    [null, "SIGTERM", "stage failed (SIGTERM)"],
  ] as const) {
    assert.throws(
      () => assertStepSucceeded("stage", { kind: "exit", code, signal }),
      (error) => error instanceof StepFailed && error.message === message,
    );
  }
  const failure = new Error("spawn failed");
  assert.throws(
    () => assertStepSucceeded("stage", { kind: "error", error: failure }),
    (error) => error === failure,
  );
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
  const failure = new StepFailed("Rust dependency audit", "1");
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

void test("a second Ctrl-C lets check stop all running steps and print their partial logs", async () => {
  const directory = mkdtempSync(join(wasmBindingsOnly, "cli-"));
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "scripts/check"), { recursive: true });
  mkdirSync(join(directory, "scripts/shared"), { recursive: true });
  mkdirSync(join(directory, "scripts/generate"), { recursive: true });
  mkdirSync(join(directory, "apps/worker/tests"), { recursive: true });
  mkdirSync(join(directory, "crates/viewer/pkg"), { recursive: true });
  writeFileSync(join(directory, "apps/worker/tests/container.e2e.ts"), "");
  writeFileSync(join(directory, "crates/viewer/pkg/madori_viewer.d.ts"), "");
  writeFileSync(join(directory, "scripts/generate/generate-geometry.ts"), "");
  for (const path of ["scripts/check/check.ts", "scripts/shared/repository.ts"])
    copyFileSync(join(original, path), join(directory, path));
  for (const path of [
    "node_modules",
    "scripts/check/layout-contract.ts",
    "scripts/check/rust-inputs.ts",
    "scripts/check/test-results.ts",
    "scripts/shared/docker-slots.ts",
    "scripts/shared/processes.ts",
    "scripts/shared/rust-build.ts",
    "scripts/shared/rustup-cargo.ts",
  ])
    symlinkSync(join(original, path), join(directory, path));
  writeFileSync(
    join(directory, "bin/cargo"),
    `#!/bin/sh
[ -n "$RUSTUP_TOOLCHAIN" ] && exec "$RUSTUP_TOOLCHAIN/bin/cargo" "$@"
if [ "$1" = metadata ]; then echo '{"packages":[],"workspace_members":[]}'; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "bin/pnpm"),
    `#!${process.execPath}
import { existsSync, writeFileSync, renameSync, writeSync } from "node:fs";
if (process.argv[3] !== "tsc") process.exit(0);
const project = process.argv[5];
writeSync(1, "stdout " + project + "\\n");
writeSync(2, "stderr " + project + "\\n");
if (project === "apps/worker/tests/rpc/tsconfig.json") process.exit(0);
if (project === "scripts/tsconfig.json") process.exit(7);
const marker = process.env.STEP_DIRECTORY + "/" + process.pid;
process.on("SIGTERM", () => {
  writeFileSync(marker + ".stopping", "");
  setInterval(() => {
    if (existsSync(process.env.STEP_DIRECTORY + "/release")) process.exit(1);
  }, 10);
});
writeFileSync(marker + ".tmp", "");
renameSync(marker + ".tmp", marker + ".pid");
setTimeout(() => process.exit(1), 15000);
`,
    { mode: 0o755 },
  );
  const check = spawn(process.execPath, [join(directory, "scripts/check/check.ts"), "--fast"], {
    env: {
      ...process.env,
      PATH: join(directory, "bin") + ":" + process.env["PATH"],
      TMPDIR: directory,
      STEP_DIRECTORY: directory,
      GITHUB_ACTIONS: "true",
      RUSTUP_TOOLCHAIN: undefined,
      MADORI_TEST_RESULTS_DIR: join(directory, "results"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    killSignal: "SIGKILL",
  });
  const closed = once(check, "close");
  const stderr = text(check.stderr);
  let output = "";
  check.stdout.setEncoding("utf8");
  check.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  const running = () =>
    readdirSync(directory)
      .filter((path) => path.endsWith(".pid"))
      .map((path) => Number(path.slice(0, -4)));
  try {
    const deadline = Date.now() + 10000;
    while (
      running().length < 2 ||
      !output.includes("TypeScript types: apps/worker/tests/rpc: ") ||
      !output.includes("TypeScript types: scripts failed (7)")
    ) {
      assert(
        check.exitCode === null && check.signalCode === null && Date.now() < deadline,
        "two tsc stubs did not start",
      );
      await sleep(10);
    }
    const pids = running();
    assert(existsSync(join(directory, "results")), "check used the given results directory");
    check.kill("SIGINT");
    while (!pids.every((pid) => existsSync(join(directory, `${pid}.stopping`)))) {
      assert(Date.now() < deadline, "a tsc stub did not receive SIGTERM");
      await sleep(10);
    }
    check.kill("SIGINT");
    writeFileSync(join(directory, "release"), "");
    assert.deepEqual(await closed, [1, null]);
    assert.match(await stderr, /\[check\] Check interrupted/);
    assert(!readdirSync(directory).some((path) => path.startsWith("madori-check-logs-")));
    for (const [project, status] of [
      ["apps/worker/tests/rpc", ": \\d+\\.\\d+s"],
      ["scripts", " failed \\(7\\) after \\d+\\.\\d+s"],
      ["apps/worker", " interrupted"],
      ["apps/worker/tests", " interrupted"],
    ] as const) {
      const label = `TypeScript types: ${project}`;
      const config = `${project}/tsconfig.json`;
      assert.match(
        output,
        new RegExp(
          `\\[check\\] ${label}\nstdout ${config}\nstderr ${config}\n\\[check\\] ${label}${status}\n`,
        ),
      );
    }
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    writeFileSync(join(directory, "release"), "");
    if (check.exitCode === null && check.signalCode === null) check.kill("SIGINT");
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
    const outputs = new Map<string, string | undefined>();
    await runChecks(
      mode,
      [],
      (label, _command, args, _env, output) => {
        commands.set(label, args);
        outputs.set(label, output);
        return Promise.resolve();
      },
      { ...ungated, rustStage: (label) => gated.push(label) },
      resultsDir,
      force,
    );
    for (const label of [
      "Generate internal API contract",
      "Clippy: native",
      "Clippy: Wasm",
      "Rust tests",
      wireLabel,
    ])
      assert.equal(commands.has(label), build, label);
    assert(!gated.includes("TypeScript tests"));
    assert.equal(gated.includes(wireLabel), build);
    assert.equal(outputs.get("TypeScript tests"), build ? "capture" : "inherit");
    const ts = commands.get("TypeScript tests");
    assert(ts);
    assert(ts.includes("apps/worker/tests/example.test.ts"));
    assert(ts.includes(`--test-skip-pattern=^${wireName}$`));
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
    "Clippy: native",
    "Clippy: Wasm",
    "Rust tests",
    wireLabel,
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

function setCi(t: TestContext, value?: string) {
  const previous = process.env.GITHUB_ACTIONS;
  if (value === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

void test("the static group never exceeds its concurrency limit", async () => {
  const released = deferred();
  let running = 0;
  let peak = 0;
  let completed = 0;
  const tasks = Array.from({ length: 7 }, () => async () => {
    running++;
    peak = Math.max(peak, running);
    await released.promise;
    running--;
    completed++;
  });
  const group = runGroup(tasks, 3);
  assert.equal(running, 3);
  released.resolve();
  await group;
  assert.equal(peak, 3);
  assert.equal(completed, 7);
});

void test("a fatal static error closes the queue and waits for started tasks", async () => {
  const first = deferred();
  const second = deferred();
  const expected = new Error("the first task could not start");
  const later = new Error("the second task could not start");
  let queued = false;
  let settled = false;
  const done = assert
    .rejects(
      runGroup(
        [
          () => first.promise,
          () => second.promise,
          () => {
            queued = true;
            return Promise.resolve();
          },
        ],
        2,
      ),
      (error) => error === expected,
    )
    .then(() => {
      settled = true;
    });
  second.reject(later);
  await sleep(0);
  assert(!settled);
  first.reject(expected);
  await done;
  assert(!queued);
});

void test("static failures report every failed label in task order", async () => {
  const steps: string[] = [];
  const labels = ["TypeScript types: apps/worker/tests/rpc", "Upstream boundary", "Document paths"];
  await assert.rejects(
    runChecks(
      "--fast",
      [],
      (label) => {
        steps.push(label);
        return labels.includes(label)
          ? Promise.reject(new StepFailed(label, "1"))
          : Promise.resolve();
      },
      ungated,
      resultsDir,
      true,
    ),
    { message: labels.map((label) => label + " failed (1)").join("; ") },
  );
  assert(steps.includes("Skill argument placeholders"));
  assert(steps.includes("Clippy: Wasm"));
});

void test("local Clippy checks first, repairs failed targets, and checks both again", async (t) => {
  setCi(t);
  const steps: (string | undefined)[][] = [];
  await runChecks(
    "--fast",
    [],
    (label, _command, args, _env, output) => {
      if (!/^(?:Clippy:|Fix Rust:|Format service Rust)/.test(label)) return Promise.resolve();
      steps.push([label, output]);
      if (label === "Fix Rust: native")
        assert.deepEqual(args.slice(-3), ["--fix", "--allow-dirty", "--allow-staged"]);
      return label === "Clippy: native" && output === "capture"
        ? Promise.reject(new StepFailed(label, "1"))
        : Promise.resolve();
    },
    ungated,
    resultsDir,
    true,
  );
  assert.deepEqual(steps, [
    ["Format service Rust", undefined],
    ["Clippy: native", "capture"],
    ["Clippy: Wasm", "capture"],
    ["Fix Rust: native", undefined],
    ["Format service Rust", undefined],
    ["Clippy: native", undefined],
    ["Clippy: Wasm", undefined],
  ]);
});

void test("CI reports Clippy failures without trying to repair them", async (t) => {
  setCi(t, "");
  const steps: string[] = [];
  const failure = new StepFailed("Clippy: native", "1");
  await assert.rejects(
    runChecks(
      "--fast",
      [],
      (label) => {
        steps.push(label);
        return label === "Clippy: native" ? Promise.reject(failure) : Promise.resolve();
      },
      ungated,
      resultsDir,
      true,
    ),
    (error) => error === failure,
  );
  assert(!steps.some((label) => label.startsWith("Fix Rust:")));
  assert.equal(steps.filter((label) => label === "Format service Rust").length, 1);
});

void test("local Clippy and other static failures are reported together without repair", async (t) => {
  setCi(t);
  const steps: string[] = [];
  await assert.rejects(
    runChecks(
      "--fast",
      [],
      (label) => {
        steps.push(label);
        return ["Upstream boundary", "Clippy: native", "Clippy: Wasm"].includes(label)
          ? Promise.reject(new StepFailed(label, "1"))
          : Promise.resolve();
      },
      ungated,
      resultsDir,
      true,
    ),
    { message: "Upstream boundary failed (1); Clippy: native failed (1); Clippy: Wasm failed (1)" },
  );
  assert(!steps.some((label) => label.startsWith("Fix Rust:")));
});

void test("both Prettier passes use the content cache, even after ESLint fails", async () => {
  const commands: string[][] = [];
  const failure = new StepFailed("Fix and lint TypeScript", "1");
  await assert.rejects(
    runChecks(
      "--fast",
      [],
      (_label, command, args) => {
        const invoked = [command, ...args];
        if (prettierWrite(invoked)) commands.push(args);
        return eslintFix(invoked) ? Promise.reject(failure) : Promise.resolve();
      },
      ungated,
      resultsDir,
      true,
    ),
    (error) => error === failure,
  );
  const flags = [
    "--cache",
    "--cache-strategy",
    "content",
    "--cache-location",
    "node_modules/.cache/madori-check/prettier",
  ];
  assert.deepEqual(
    commands.map((args) => args.slice(-flags.length)),
    [flags, flags],
  );
});

void test("the local ESLint cache follows generated and ignored inputs, and CI runs uncached", async (t) => {
  setCi(t);
  const directory = mkdtempSync(join(tmpdir(), "madori-eslint-cache-"));
  process.chdir(directory);
  t.after(() => {
    process.chdir(wasmBindingsOnly);
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync("apps/worker/tests", { recursive: true });
  writeFileSync("apps/worker/tests/container.e2e.ts", "");
  mkdirSync("crates/viewer/pkg", { recursive: true });
  writeFileSync("crates/viewer/pkg/madori_viewer.d.ts", "");
  writeFileSync(".gitignore", "ignored.d.ts\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args]);
  git("init", "-q");
  writeFileSync("deleted.ts", "");
  git("add", "deleted.ts");
  git("check-ignore", "ignored.d.ts");
  const generated = "generated.ts";
  const ignored = "ignored.d.ts";
  let generatedContents = "";
  async function lintArgs() {
    let args: string[] | undefined;
    await runChecks(
      "--fast",
      [],
      (label, _command, commandArgs) => {
        if (label === "Generate internal body validators")
          writeFileSync(generated, generatedContents);
        if (label === "Fix and lint TypeScript") args = commandArgs;
        return Promise.resolve();
      },
      ungated,
      resultsDir,
      true,
    );
    assert(args);
    return args;
  }
  async function cache() {
    const args = await lintArgs();
    const path = args.at(-1);
    assert(path);
    assert.deepEqual(args.slice(-5, -1), [
      "--cache",
      "--cache-strategy",
      "content",
      "--cache-location",
    ]);
    assert.match(path, /^node_modules\/\.cache\/madori-check\/eslint-[a-f0-9]{64}\.json$/);
    return path;
  }
  writeFileSync(ignored, "export type Value = string;");
  const initial = await cache();
  assert.equal(await cache(), initial);
  mkdirSync("node_modules/.cache/madori-check", { recursive: true });
  writeFileSync(initial, "");
  writeFileSync(ignored, "export type Value = number;");
  const edited = await cache();
  assert.notEqual(edited, initial);
  assert(!existsSync(initial));
  rmSync("deleted.ts");
  const deleted = await cache();
  assert.notEqual(deleted, edited);
  assert.equal(await cache(), deleted);
  generatedContents = "export type Generated = number;";
  assert.notEqual(await cache(), deleted);

  process.env.GITHUB_ACTIONS = "true";
  assert.deepEqual(await lintArgs(), ["exec", "eslint", ".", "--fix", "--max-warnings", "0"]);
});
