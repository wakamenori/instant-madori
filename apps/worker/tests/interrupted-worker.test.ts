import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const fixtureSource = `
  import { startLocalWorker } from ${JSON.stringify(new URL("./support/local-worker.ts", import.meta.url).href)};
  await startLocalWorker();
  console.log("ready");
  setInterval(() => {}, 60_000);
`;

void test("a test process killed while its Worker runs leaves no Wrangler behind", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "interrupted-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = spawn(process.execPath, ["--input-type=module", "-e", fixtureSource], {
    env: { ...process.env, TMPDIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(fixture, "exit");
  try {
    const output: string[] = [];
    const ready = new Promise<boolean>((resolve) => {
      createInterface({ input: fixture.stdout }).on("line", (line) => {
        output.push(line);
        if (line === "ready") resolve(true);
      });
      createInterface({ input: fixture.stderr }).on("line", (line) => output.push(line));
    });
    assert(
      await Promise.race([
        ready,
        exited.then(() => false),
        setTimeout(60_000, false, { ref: false }),
      ]),
      output.join("\n") || "fixture did not report ready",
    );
    assert(fixture.pid);
    const { stdout } = await promisify(execFile)("pgrep", ["-P", String(fixture.pid)]);
    assert.match(stdout.trim(), /^[1-9]\d*$/, "expected one Wrangler group leader");
    const leader = Number(stdout.trim());
    assert(Number.isSafeInteger(leader));
    assert(fixture.kill("SIGKILL"));
    await exited;

    const deadline = performance.now() + 15_000;
    for (;;) {
      try {
        process.kill(-leader, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
        throw error;
      }
      if (performance.now() >= deadline) break;
      await setTimeout(100);
    }
    process.kill(-leader, "SIGKILL");
    assert.fail("the Wrangler group outlived its killed test process");
  } finally {
    fixture.kill("SIGKILL");
    await exited;
  }
});

async function checkInterruptedBuild(t: TestContext, end: "kill" | "timeout") {
  const directory = await mkdtemp(join(tmpdir(), "interrupted-build-"));
  const fake = join(directory, "docker");
  const marker = join(directory, "build.pid");
  const host = `unix://${directory}/missing.sock`;
  await writeFile(
    fake,
    `#!/bin/sh
case "$1" in
  context) printf '{"Current":true,"DockerEndpoint":"%s"}\\n' "$DOCKER_HOST" ;;
  info) exit 0 ;;
  build) cat >/dev/null; echo "$$" > "$BUILD_PID"; exec sleep 600 ;;
  *) echo "unexpected docker command: $*" >&2; exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const source = `
    import { startLocalWorker } from ${JSON.stringify(new URL("./support/local-worker.ts", import.meta.url).href)};
    process.stdin.on("end", () => process.exit());
    process.stdin.resume();
    try {
      const worker = await startLocalWorker({ containers: true, readyTimeoutMs: ${end === "kill" ? 60_000 : 20_000} });
      await worker.stop();
      throw new Error("unexpected ready Worker");
    } catch (error) {
      if (!String(error).includes("Server startup timed out")) throw error;
      console.log("startup timed out");
      process.stdin.pause();
    }
  `;
  const fixture = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      TMPDIR: directory,
      BUILD_PID: marker,
      WRANGLER_DOCKER_BIN: fake,
      MADORI_DOCKER_TETHER_TARGET: "",
      WRANGLER_DOCKER_HOST: host,
      DOCKER_HOST: host,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(fixture, "exit");
  const lines: string[] = [];
  for (const input of [fixture.stdout, fixture.stderr]) {
    createInterface({ input }).on("line", (line) => lines.push(line));
  }
  t.after(async () => {
    fixture.kill("SIGKILL");
    await exited;
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  await t.waitFor(
    () => assert(existsSync(marker) && readFileSync(marker, "utf8").trim(), lines.join("\n")),
    { timeout: 60_000 },
  );
  const pid = Number(readFileSync(marker, "utf8"));
  assert(Number.isSafeInteger(pid) && pid > 1);
  if (end === "kill") assert(fixture.kill("SIGKILL"));
  const result = await Promise.race([exited, setTimeout(45_000, undefined, { ref: false })]);
  assert(result, lines.join("\n"));
  if (end === "timeout") {
    assert.equal(result[0], 0, lines.join("\n"));
    assert(lines.includes("startup timed out"), lines.join("\n"));
  }
  await t.waitFor(
    () =>
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `build ${pid} survived ${end}`),
    { timeout: 15_000 },
  );
}

void test("a test process killed while Wrangler builds the Container image leaves no build behind", (t) =>
  checkInterruptedBuild(t, "kill"));
void test("a Worker that fails to start while its image builds leaves no build behind", (t) =>
  checkInterruptedBuild(t, "timeout"));
