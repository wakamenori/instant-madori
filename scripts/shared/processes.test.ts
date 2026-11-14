import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { start, stop } from "./processes.ts";

const zombieGroup = String.raw`
import json, os, select, signal

group = os.getpid()
ready_read, ready_write = os.pipe()
if os.fork() == 0:
    os.close(ready_read)
    os.setpgid(0, 0)
    children = []
    for live in [False, True]:
        pid = os.fork()
        if pid == 0:
            os.setpgid(0, group)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            os.write(ready_write, b".")
            if live:
                signal.pause()
            os._exit(0)
        children.append(pid)
    print(json.dumps(children), flush=True)
    select.select([3], [], [], 20)
    for pid in children:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os._exit(0)
os.close(ready_write)
for _ in range(2):
    os.read(ready_read, 1)
os._exit(0)
`;

async function waitForState(pid: number, zombie: boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    if (state.startsWith("Z") === zombie) return;
    await setTimeout(10);
  }
  assert.fail(`Process ${pid} did not reach zombie=${zombie}`);
}

async function startZombieGroup(t: TestContext) {
  const run = start("/usr/bin/python3", ["-c", zombieGroup], {
    stdio: ["ignore", "pipe", "inherit", "pipe"],
  });
  const closed = once(run.child, "close");
  t.after(async () => {
    run.child.stdio[3]?.destroy();
    await closed;
  });
  assert.ok(run.child.stdout);
  const lines = createInterface({ input: run.child.stdout });
  const line: unknown = (await once(lines, "line"))[0];
  assert.ok(typeof line === "string");
  const [zombie, live] = z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .parse(JSON.parse(line));
  assert.deepEqual(await run.finished, { kind: "exit", code: 0, signal: null });
  assert.ok(run.child.pid);
  await waitForState(zombie, true);
  await waitForState(live, false);
  return { run, group: -run.child.pid, zombie, live };
}

await test(
  "macOS signals a mixed group, then reports EPERM for only zombies",
  {
    skip: process.platform !== "darwin",
    timeout: 15_000,
  },
  async (t) => {
    const { run, group, zombie, live } = await startZombieGroup(t);
    assert.equal(process.kill(group, "SIGKILL"), true);
    await waitForState(zombie, true);
    await waitForState(live, true);
    assert.throws(() => process.kill(group, "SIGKILL"), { code: "EPERM" });
    await stop([run]);
  },
);

await test(
  "stop still kills a live descendant when its leader has exited",
  {
    skip: process.platform !== "darwin",
    timeout: 15_000,
  },
  async (t) => {
    const { run, live } = await startZombieGroup(t);
    await stop([run]);
    await waitForState(live, true);
  },
);

for (const termination of ["exit", "signal"] as const) {
  await test(`stop permits EPERM after the child finishes by ${termination}`, async (t) => {
    const run = start(
      process.execPath,
      ["-e", termination === "exit" ? "process.exit(0)" : "process.kill(process.pid, 'SIGTERM')"],
      { stdio: "ignore" },
    );
    await run.finished;
    const kill = t.mock.method(process, "kill", () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    await stop([run]);
    assert.ok(kill.mock.callCount() > 0);
  });
}

await test("stop rejects EPERM while the child is still running", async (t) => {
  const run = start(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(async () => {
    run.child.kill("SIGKILL");
    await run.finished;
  });
  await once(run.child, "spawn");
  const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  t.mock.method(process, "kill", () => {
    throw error;
  });
  await assert.rejects(stop([run]), (actual: unknown) => actual === error);
  assert.equal(run.child.exitCode, null);
  assert.equal(run.child.signalCode, null);
});
