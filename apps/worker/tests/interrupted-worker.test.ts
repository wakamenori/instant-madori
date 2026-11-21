import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
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
