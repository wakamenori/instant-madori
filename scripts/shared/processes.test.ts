import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { killGroup, start, startTethered, stop } from "./processes.ts";

const zombieGroup = String.raw`
import json, os, select, signal, subprocess, sys, time

live_flags = json.loads(sys.argv[1])
control = int(sys.argv[2])

group = os.getpid()
ready_read, ready_write = os.pipe()
if os.fork() == 0:
    os.close(ready_read)
    os.setpgid(0, 0)
    children = []
    for live in live_flags:
        pid = os.fork()
        if pid == 0:
            os.setpgid(0, group)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            if live:
                os.write(ready_write, b".")
                signal.pause()
            os._exit(0)
        children.append(pid)
        if not live:
            while not subprocess.check_output(["ps", "-o", "stat=", "-p", str(pid)]).strip().startswith(b"Z"):
                time.sleep(0.01)
            os.write(ready_write, b".")
    print(json.dumps(children), flush=True)
    select.select([control], [], [], 20)
    for pid in children:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os._exit(0)
os.close(ready_write)
for _ in live_flags:
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

async function zombieFixture(t: TestContext, tethered: boolean, live: boolean[]) {
  // The tether passes only stdio 0-2 on, and Node closes a direct child's stdin when it exits.
  const control = tethered ? "0" : "3";
  const launch = tethered ? startTethered : start;
  const run = launch("/usr/bin/python3", ["-c", zombieGroup, JSON.stringify(live), control], {
    stdio: tethered ? ["pipe", "pipe", "inherit"] : ["ignore", "pipe", "inherit", "pipe"],
  });
  const closed = once(run.child, "close");
  t.after(async () => {
    if (tethered) run.child.stdin?.end();
    else run.child.stdio[3]?.destroy();
    await closed;
  });
  assert.ok(run.child.stdout);
  const lines = createInterface({ input: run.child.stdout });
  const line: unknown = (await once(lines, "line"))[0];
  assert.ok(typeof line === "string");
  return { run, children: JSON.parse(line) as unknown };
}

async function startZombieGroup(t: TestContext) {
  const { run, children } = await zombieFixture(t, false, [false, true]);
  const [zombie, live] = z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .parse(children);
  assert.deepEqual(await run.finished, { kind: "exit", code: 0, signal: null });
  assert.ok(run.child.pid);
  await waitForState(zombie, true);
  await waitForState(live, false);
  return { run, group: -run.child.pid, zombie, live };
}

await test(
  "the tether preserves the server exit code when only zombies remain",
  { skip: process.platform !== "darwin", timeout: 15_000 },
  async (t) => {
    const { run, children } = await zombieFixture(t, true, [false]);
    z.tuple([z.number().int().positive()]).parse(children);
    assert.deepEqual(await run.finished, { kind: "exit", code: 0, signal: null });
  },
);

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

for (const code of ["EPERM", "EINVAL"]) {
  await test(`killGroup rethrows ${code} for a live group`, async (t) => {
    const run = start(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    t.after(async () => {
      run.child.kill("SIGKILL");
      await run.finished;
    });
    await once(run.child, "spawn");
    const group = run.child.pid;
    assert.ok(group);
    const error = Object.assign(new Error(`kill ${code}`), { code });
    t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals) => {
      assert.equal(pid, -group);
      assert.equal(signal, "SIGKILL");
      throw error;
    });
    assert.throws(
      () => killGroup(group),
      (actual: unknown) => actual === error,
    );
  });
}

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

await test(
  "stop permits SIGTERM EPERM before Node reaps the exited child",
  { skip: process.platform !== "darwin", timeout: 15_000 },
  async (t) => {
    const run = start("/usr/bin/true", [], { stdio: "ignore" });
    t.after(async () => {
      run.child.kill("SIGKILL");
      await run.finished;
    });
    assert.ok(run.child.pid);
    const group = -run.child.pid;
    const deadline = Date.now() + 5_000;
    let state: string;
    do {
      // Keep Node from reaping the child until stop() sends SIGTERM.
      state = execFileSync("ps", ["-o", "stat=", "-p", String(run.child.pid)], {
        encoding: "utf8",
        timeout: 1_000,
      }).trim();
    } while (!state.startsWith("Z") && Date.now() < deadline);
    assert.match(state, /^Z/);
    assert.equal(run.child.exitCode, null);
    assert.equal(run.child.signalCode, null);
    assert.throws(() => process.kill(group, "SIGTERM"), { code: "EPERM" });
    await stop([run]);
    assert.deepEqual(await run.finished, { kind: "exit", code: 0, signal: null });
  },
);

await test(
  "stop rejects EPERM while the child is still running",
  { timeout: 10_000 },
  async (t) => {
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
  },
);

async function startStopPair(t: TestContext, script: string) {
  const a = start(process.execPath, ["-e", script], { stdio: "ignore" });
  const b = start(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(async () => {
    a.child.kill("SIGKILL");
    b.child.kill("SIGKILL");
    await Promise.all([a.finished, b.finished]);
  });
  assert.ok(b.child.stdout);
  await once(createInterface({ input: b.child.stdout }), "line");

  assert.ok(a.child.pid);
  const group = -a.child.pid;
  const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === group && (signal === "SIGTERM" || signal === "SIGKILL")) throw error;
    return kill(pid, signal);
  });
  return { a, b, error };
}

await test(
  "stop kills the other children before rejecting EPERM for a running child",
  { timeout: 15_000 },
  async (t) => {
    const { a, b, error } = await startStopPair(t, "setInterval(() => {}, 1000)");
    await assert.rejects(stop([a, b]), (actual: unknown) => actual === error);
    assert.equal(b.child.signalCode, "SIGKILL");
    assert.deepEqual(await b.finished, { kind: "exit", code: null, signal: "SIGKILL" });
    assert.equal(a.child.exitCode, null);
    assert.equal(a.child.signalCode, null);
  },
);

await test("stop shares one grace deadline across children", { timeout: 15_000 }, async (t) => {
  const { a, b } = await startStopPair(t, "setTimeout(() => {}, 3000)");
  const started = performance.now();
  await stop([a, b]);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 6000, `stop took ${elapsed.toFixed(0)} ms`);
  assert.deepEqual(await b.finished, { kind: "exit", code: null, signal: "SIGKILL" });
});

const fakeWorkerd = `
  const fs = require("node:fs");
  process.on("SIGTERM", () => fs.appendFileSync(process.env.LOG, process.pid + "\\n"));
  process.stdin.resume().on("end", () => setTimeout(() => process.exit(0), 100));
  fs.writeFileSync(process.env.PIDS, JSON.stringify([process.ppid, process.pid]));
`;

const fakeWrangler = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(fakeWorkerd)}], {
    stdio: ["pipe", "ignore", "inherit"],
  });
  process.on("SIGTERM", () => {
    require("node:fs").appendFileSync(process.env.LOG, process.pid + "\\n");
    if (process.env.IGNORE_TERM !== "1") child.stdin.end();
  });
`;

async function serverFixture(t: TestContext, mode: "normal" | "orphan" | "stubborn") {
  const directory = await mkdtemp(join(tmpdir(), "madori-server-"));
  const log = join(directory, "signals");
  const pidFile = join(directory, "pids");
  const options = {
    env: { ...process.env, LOG: log, PIDS: pidFile, IGNORE_TERM: mode === "stubborn" ? "1" : "0" },
  };
  const spawner = `
    import { startTethered } from ${JSON.stringify(new URL("./processes.ts", import.meta.url).href)};
    startTethered(process.execPath, ["-e", ${JSON.stringify(fakeWrangler)}]);
  `;
  const run =
    mode === "orphan"
      ? start(process.execPath, ["--input-type=module", "-e", spawner], options)
      : startTethered(process.execPath, ["-e", fakeWrangler], options);
  let group: number | undefined;
  t.after(async () => {
    run.child.kill("SIGKILL");
    if (group !== undefined) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await run.finished;
    await rm(directory, { recursive: true });
  });
  const pids = await t.waitFor(
    async () =>
      z
        .tuple([z.number().int().positive(), z.number().int().positive()])
        .parse(JSON.parse(await readFile(pidFile, "utf8"))),
    { timeout: 5000 },
  );
  group = pids[0];
  async function assertStopped() {
    await t.waitFor(
      () => {
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      },
      { timeout: 2000 },
    );
    group = undefined;
    assert.equal(await readFile(log, "utf8"), `${pids[0]}\n`);
  }
  return { run, assertStopped };
}

await test("stop signals only the server leader and leaves both processes gone", async (t) => {
  const { run, assertStopped } = await serverFixture(t, "normal");
  await stop([run]);
  await assertStopped();
  assert.deepEqual(await run.finished, { kind: "exit", code: 0, signal: null });
});

await test("killing the spawner stops the server and its child", async (t) => {
  const { run, assertStopped } = await serverFixture(t, "orphan");
  run.child.kill("SIGKILL");
  await assertStopped();
});

await test("the tether kills a stubborn server and its group after the grace", async (t) => {
  const { run, assertStopped } = await serverFixture(t, "stubborn");
  await stop([run]);
  await assertStopped();
  assert.deepEqual(await run.finished, { kind: "exit", code: 137, signal: null });
});
