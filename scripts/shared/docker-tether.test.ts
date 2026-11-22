import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { dockerTetherEnv } from "./docker-tether.ts";

const standIn = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.env.WRANGLER_DOCKER_BIN, process.argv.slice(1), {
    detached: true, stdio: ["pipe", "inherit", "inherit"],
  });
  require("node:fs").writeFileSync(process.env.TETHER_PID, String(child.pid));
  child.stdin.end("Dockerfile contents\\n");
  child.on("exit", (code) => process.exit(code ?? 1));
`;

async function run(t: TestContext, script: string, spawner?: number) {
  const dir = await mkdtemp(join(tmpdir(), "docker-tether-"));
  const fake = join(dir, "docker");
  const tetherFile = join(dir, "tether.pid");
  const buildFile = join(dir, "build.pid");
  await writeFile(fake, "#!/bin/sh\n" + script, { mode: 0o755 });
  const env = {
    ...process.env,
    ...dockerTetherEnv({ WRANGLER_DOCKER_BIN: fake }),
    TETHER_PID: tetherFile,
    BUILD_PID: buildFile,
  };
  const fixture = spawn(
    process.execPath,
    spawner === undefined
      ? ["-e", standIn, "build"]
      : [join(import.meta.dirname, "docker-tether.ts"), String(spawner)],
    { env, stdio: "ignore" },
  );
  const exited = once(fixture, "exit");
  t.after(async () => {
    fixture.kill("SIGKILL");
    await exited;
    for (const file of [buildFile, tetherFile]) {
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { fixture, exited, buildFile, tetherFile };
}

const sleepBuild = 'echo "$$" > "$BUILD_PID"; exec sleep 600';

async function buildPid(t: TestContext, file: string) {
  return await t.waitFor(
    () => {
      const pid = Number(readFileSync(file, "utf8"));
      assert(Number.isSafeInteger(pid) && pid > 1);
      return pid;
    },
    { timeout: 5000 },
  );
}

async function gone(t: TestContext, pid: number) {
  await t.waitFor(() => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }), {
    timeout: 5000,
  });
}

void test("the build receives its arguments and Dockerfile and returns its status", async (t) => {
  const { exited } = await run(
    t,
    'read -r line && [ "$line" = "Dockerfile contents" ] && [ "$1" = build ] && exit 3\nexit 4',
  );
  assert.deepEqual(await exited, [3, null]);
});

void test("SIGPIPE from docker returns status 141", async (t) => {
  const { exited } = await run(t, 'kill -PIPE "$$"');
  assert.deepEqual(await exited, [141, null]);
});

void test("killing one Wrangler stops only its build", async (t) => {
  const first = await run(t, sleepBuild);
  const second = await run(t, sleepBuild);
  const firstPid = await buildPid(t, first.buildFile);
  const secondPid = await buildPid(t, second.buildFile);
  first.fixture.kill("SIGKILL");
  await gone(t, firstPid);
  process.kill(secondPid, 0);
  second.fixture.kill("SIGTERM");
  await gone(t, secondPid);
});

void test("Wrangler can abort the tether and build together", async (t) => {
  const session = await run(t, sleepBuild);
  const build = await buildPid(t, session.buildFile);
  const tether = await buildPid(t, session.tetherFile);
  process.kill(-tether, "SIGTERM");
  await gone(t, build);
  await gone(t, tether);
});

void test("an orphaned launcher never starts docker", async (t) => {
  for (const parent of [1, process.ppid]) {
    const { exited, buildFile } = await run(t, 'touch "$BUILD_PID"', parent);
    assert.deepEqual(await exited, [1, null]);
    assert(!existsSync(buildFile));
  }
});

void test("wrapping the configured docker binary preserves its target", () => {
  const env = dockerTetherEnv({ WRANGLER_DOCKER_BIN: "/tmp/example-docker" });
  assert.equal(env.MADORI_DOCKER_TETHER_TARGET, "/tmp/example-docker");
  assert.deepEqual(dockerTetherEnv(env), env);
  assert.equal(
    dockerTetherEnv({
      WRANGLER_DOCKER_BIN: env.WRANGLER_DOCKER_BIN,
      MADORI_DOCKER_TETHER_TARGET: env.WRANGLER_DOCKER_BIN,
    }).MADORI_DOCKER_TETHER_TARGET,
    "docker",
  );
});
