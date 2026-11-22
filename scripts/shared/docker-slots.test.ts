import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  machineSlots,
  minimumFreeBytes,
  requireFreeDisk,
  withDockerSlot,
  type DockerSlots,
} from "./docker-slots.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "docker-slots-"));
  const directory = join(root, "slots");
  const state = { free: 100 * 1024 ** 3 };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousHome = process.env.INSTANT_MADORI_METRICS_HOME;
  process.env.INSTANT_MADORI_METRICS_HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.INSTANT_MADORI_METRICS_HOME;
    else process.env.INSTANT_MADORI_METRICS_HOME = previousHome;
  });
  const lines: string[] = [];
  const controller = new AbortController();
  function run<T>(
    purpose: string,
    work: (name: string | undefined) => Promise<T>,
    pool: Extract<DockerSlots, { kind: "flock" }>["pool"] = "development",
    signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  ) {
    return withDockerSlot(
      { kind: "flock", directory, pool, freeBytes: () => state.free },
      { purpose, signal, log: (line) => lines.push(line), pace: { pollMs: 10, reportEveryMs: 50 } },
      work,
    );
  }
  function hold(purpose: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = run(purpose, () => gate);
    async function finish() {
      release();
      await done;
    }
    t.after(finish);
    return finish;
  }
  return { run, hold, lines, controller, directory, root, state };
}
const immediate = (name: string | undefined) => Promise.resolve(name);

void test(
  "a third developer waits, reports both holders periodically, then takes a released slot",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { hold, run, lines } = fixture(t);
    const release = hold("first");
    hold("second");
    let entered = false;
    const third = run("third", (name) => {
      entered = true;
      return immediate(name);
    });
    const waiting = () => lines.filter((line) => line.includes(" waiting "));
    assert.equal(waiting().length, 1);
    await sleep(125);
    assert(!entered);
    assert(waiting().length >= 2);
    for (const line of waiting()) {
      assert(line.includes(`development-1: first (pid ${process.pid},`));
      assert(line.includes(`development-2: second (pid ${process.pid},`));
    }
    await release();
    assert.equal(await third, "development-1");
  },
);

void test(
  "runner acquires while both developers are busy",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { hold, run, lines } = fixture(t);
    hold("first");
    hold("second");
    assert.equal(await run("ci", immediate, "runner"), "runner-1");
    assert(lines.some((line) => /acquired runner-1.*first .*second /.test(line)));
    assert(!lines.some((line) => line.includes(" waiting ")));
  },
);

void test(
  "SIGKILL returns a slot even with a stale holder record",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, directory, lines } = fixture(t);
    const children = [];
    for (const purpose of ["first", "second"]) {
      const source = `import {withDockerSlot} from ${JSON.stringify(new URL("./docker-slots.ts", import.meta.url).href)};
    await withDockerSlot({kind:"flock",directory:process.argv[1],pool:"development",freeBytes:()=>100*1024**3},{purpose:process.argv[2],signal:AbortSignal.timeout(5000),log:()=>{}},()=>{console.log("ready");return new Promise(()=>setInterval(()=>{},60000));});`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", source, directory, purpose],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const exited = once(child, "exit");
      t.after(async () => {
        child.kill("SIGKILL");
        await exited;
      });
      const ready = await Promise.race([once(child.stdout, "data"), exited]);
      assert.equal(String(ready[0]).trim(), "ready");
      children.push({ child, exited });
    }
    const first = children[0];
    assert(first);
    first.child.kill("SIGKILL");
    await first.exited;
    assert.equal(await run("replacement", immediate), "development-1");
    assert(!lines.some((line) => line.includes(" waiting ")));
  },
);

void test(
  "a rejected callback returns its slot",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, hold, lines } = fixture(t);
    hold("first");
    const failure = new Error("failed");
    await assert.rejects(
      run("fails", () => Promise.reject(failure)),
      (error) => error === failure,
    );
    assert.equal(await run("replacement", immediate), "development-2");
    assert(!lines.some((line) => line.includes(" waiting ")));
  },
);

void test(
  "aborting a waiter propagates the reason and leaves the slot available",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, hold, lines } = fixture(t);
    const release = hold("first");
    hold("second");
    const controller = new AbortController();
    const waiting = run("waiting", immediate, "development", controller.signal);
    const reason = new Error("interrupted");
    controller.abort(reason);
    await assert.rejects(waiting, (error) => error === reason);
    assert(lines.some((line) => line.includes("stopped waiting for a development slot")));
    await release();
    assert.equal(await run("replacement", immediate), "development-1");
  },
);

void test(
  "development waiters leave the runner lock available",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, hold, controller, directory } = fixture(t);
    hold("first");
    hold("second");
    const waiting = run("waiting", immediate);
    try {
      const probe = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { constants, openSync, closeSync } from "node:fs";
      const end=performance.now()+200;
      do {closeSync(openSync(process.argv[1], constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | 0x20));} while(performance.now()<end);
    `,
          join(directory, "runner-1.lock"),
        ],
        { stdio: "inherit" },
      );
      assert.equal((await once(probe, "exit"))[0], 0);
    } finally {
      controller.abort();
      await assert.rejects(waiting);
    }
  },
);

void test(
  "unidentified busy slots show starting only for the waiting pool",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, hold, controller, directory, lines } = fixture(t);
    hold("first");
    hold("second");
    writeFileSync(join(directory, "development-1.lock"), "{");
    const dead = JSON.stringify({
      pid: 2147483647,
      purpose: "gone",
      cwd: "/",
      since: new Date().toISOString(),
    });
    for (const name of ["development-2", "runner-1"])
      writeFileSync(join(directory, name + ".lock"), dead);
    const waiting = run("waiting", immediate);
    controller.abort();
    await assert.rejects(waiting);
    assert(
      lines.some((line) =>
        line.includes(
          "development-1: held (starting); development-2: held (starting); runner-1: free",
        ),
      ),
    );
  },
);

void test(
  "nested acquisition fails before starting work",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, lines } = fixture(t);
    const prior = process.env["MADORI_DOCKER_SLOT"];
    process.env["MADORI_DOCKER_SLOT"] = "outer";
    try {
      await assert.rejects(run("nested", immediate), /Already inside Docker slot outer/);
      assert.deepEqual(lines, []);
    } finally {
      if (prior === undefined) delete process.env["MADORI_DOCKER_SLOT"];
      else process.env["MADORI_DOCKER_SLOT"] = prior;
    }
  },
);

void test(
  "release clears the holder shown to the runner",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, lines } = fixture(t);
    assert.equal(await run("developer", immediate), "development-1");
    await run("ci", immediate, "runner");
    assert.match(
      lines.find((line) => line.includes("acquired runner-1")) ?? "",
      /development-1: free/,
    );
  },
);

void test("work runs immediately without a slot on Linux", async () => {
  const lines: string[] = [];
  let called = false;
  const result = withDockerSlot(
    { kind: "none", platform: "linux" },
    { purpose: "ci", signal: new AbortController().signal, log: (line) => lines.push(line) },
    (name) => {
      called = true;
      assert.equal(name, undefined);
      return Promise.resolve(42);
    },
  );
  assert(called);
  assert.equal(await result, 42);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] ?? "",
    /^\[docker-slot\] \d{2}:\d{2}:\d{2} Docker slots work only on macOS; running without a slot on linux$/,
  );
});

void test("machine slots depend on the platform and reserve the runner pool for GitHub Actions", () => {
  assert.deepEqual(machineSlots({}, "linux"), { kind: "none", platform: "linux" });
  const defaults = machineSlots({}, "darwin");
  assert.equal(defaults.kind, "flock");
  assert(defaults.freeBytes() > 0);
  assert.equal(defaults.pool, "development");
  assert.deepEqual(machineSlots({ GITHUB_ACTIONS: "true" }, "darwin"), {
    ...defaults,
    pool: "runner",
  });
  assert.deepEqual(machineSlots({ GITHUB_ACTIONS: "false" }, "darwin"), defaults);
  assert.deepEqual(machineSlots({ HOME: "/elsewhere", TMPDIR: "/elsewhere" }, "darwin"), defaults);
});

void test(
  "slot acquisition, release and cancellation spool only lifecycle data",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, root } = fixture(t);
    const ready = join(root, "spool/ready");
    mkdirSync(ready, { recursive: true });
    mkdirSync(join(root, "spool/tmp"));
    await run("private command", immediate, "runner");
    await assert.rejects(
      run("private command", immediate, "runner", AbortSignal.abort(new Error("stop"))),
    );
    const names = readdirSync(ready);
    assert.equal(names.length, 5);
    for (const phase of ["acquired", "released", "cancelled"]) {
      const name = names.find((n) => n.endsWith("-" + phase + ".json"));
      assert.ok(name);
      assert.ok(names.includes(name.replace(phase, "started")));
      const body = readFileSync(join(ready, name), "utf8");
      assert.doesNotMatch(body, /private command/u);
      assert.ok(body.includes(JSON.stringify(process.cwd())));
    }
  },
);

void test(
  "a broken spool preserves the work result and cancellation reason",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, root } = fixture(t);
    mkdirSync(join(root, "spool/ready"), { recursive: true });
    assert.equal(await run("work", immediate), "development-1");
    const reason = new Error("cancel");
    await assert.rejects(
      run("cancelled", immediate, "development", AbortSignal.abort(reason)),
      (error) => error === reason,
    );
  },
);

void test("pnpm dev stops before creating its slot directory when disk is low", async (t) => {
  const { run, state, lines, directory, root } = fixture(t);
  state.free = minimumFreeBytes - 1;
  await assert.rejects(
    run("pnpm dev", () => assert.fail("work started")),
    {
      message:
        "Not enough free disk space before taking a development slot for pnpm dev (11.9 GiB free, below 12.0 GiB)",
    },
  );
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] ?? "",
    /^\[docker-slot\] \d{2}:\d{2}:\d{2} stopped before taking a development slot for pnpm dev: 11\.9 GiB free, below 12\.0 GiB\. Nothing was deleted\./,
  );
  assert(!existsSync(directory));
  assert.deepEqual(readdirSync(root), []);
});

void test(
  "disk at the floor allows slot acquisition",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { run, state } = fixture(t);
    state.free = minimumFreeBytes;
    assert.equal(await run("pnpm dev", immediate), "development-1");
  },
);

void test(
  "a waiter stops if disk falls below the floor",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { hold, run, lines, state } = fixture(t);
    const release = hold("first");
    hold("second");
    const waiter = run("third", () => assert.fail("waiter entered"));
    assert(lines.some((line) => line.includes(" waiting ")));
    state.free = minimumFreeBytes - 1;
    await assert.rejects(
      waiter,
      /Not enough free disk space while waiting .* for a development slot for third/,
    );
    assert(
      lines.some((line) =>
        /stopped while waiting .* for a development slot for third: 11\.9 GiB free/.test(line),
      ),
    );
    state.free = minimumFreeBytes;
    await release();
    assert.equal(await run("replacement", immediate), "development-1");
  },
);

void test("Rust stages stop below the floor and proceed silently at the floor or off macOS", (t) => {
  const { directory, state, lines } = fixture(t);
  const config = {
    kind: "flock",
    directory,
    pool: "development",
    freeBytes: () => state.free,
  } as const;
  const log = (line: string) => lines.push(line);
  state.free = minimumFreeBytes - 1;
  assert.throws(() => requireFreeDisk(config, "Rust tests", log), {
    message: "Not enough free disk space before Rust tests (11.9 GiB free, below 12.0 GiB)",
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", / stopped before Rust tests: 11\.9 GiB free, below 12\.0 GiB/);
  lines.length = 0;
  state.free = minimumFreeBytes;
  requireFreeDisk(config, "Rust tests", log);
  requireFreeDisk({ kind: "none", platform: "linux" }, "Rust tests", log);
  assert.deepEqual(lines, []);
});
