import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { machineSlots, withDockerSlot, type DockerSlots } from "./docker-slots.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "docker-slots-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lines: string[] = [];
  const controller = new AbortController();
  function run<T>(
    purpose: string,
    work: (name: string) => Promise<T>,
    pool: DockerSlots["pool"] = "development",
    signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  ) {
    return withDockerSlot(
      { directory, pool },
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
  return { run, hold, lines, controller, directory };
}
const immediate = (name: string) => Promise.resolve(name);

void test("a third developer waits, reports both holders periodically, then takes a released slot", async (t) => {
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
});

void test("runner acquires while both developers are busy", async (t) => {
  const { hold, run, lines } = fixture(t);
  hold("first");
  hold("second");
  assert.equal(await run("ci", immediate, "runner"), "runner-1");
  assert(lines.some((line) => /acquired runner-1.*first .*second /.test(line)));
  assert(!lines.some((line) => line.includes(" waiting ")));
});

void test("SIGKILL returns a slot even with a stale holder record", async (t) => {
  const { run, directory, lines } = fixture(t);
  const children = [];
  for (const purpose of ["first", "second"]) {
    const source = `import {withDockerSlot} from ${JSON.stringify(new URL("./docker-slots.ts", import.meta.url).href)};
    await withDockerSlot({directory:process.argv[1],pool:"development"},{purpose:process.argv[2],signal:AbortSignal.timeout(5000),log:()=>{}},()=>{console.log("ready");return new Promise(()=>setInterval(()=>{},60000));});`;
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
});

void test("a rejected callback returns its slot", async (t) => {
  const { run, hold, lines } = fixture(t);
  hold("first");
  const failure = new Error("failed");
  await assert.rejects(
    run("fails", () => Promise.reject(failure)),
    (error) => error === failure,
  );
  assert.equal(await run("replacement", immediate), "development-2");
  assert(!lines.some((line) => line.includes(" waiting ")));
});

void test("aborting a waiter propagates the reason and leaves the slot available", async (t) => {
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
});

void test("development waiters leave the runner lock available", async (t) => {
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
});

void test("unidentified busy slots show starting only for the waiting pool", async (t) => {
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
});

void test("nested acquisition fails before starting work", async (t) => {
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
});

void test("only GitHub Actions uses the runner pool and all worktrees share the directory", () => {
  assert.equal(machineSlots({ GITHUB_ACTIONS: "true" }).pool, "runner");
  assert.equal(machineSlots({ GITHUB_ACTIONS: "false" }).pool, "development");
  assert.equal(machineSlots({}).pool, "development");
  assert.equal(
    machineSlots({ HOME: "/elsewhere", TMPDIR: "/elsewhere" }).directory,
    machineSlots({}).directory,
  );
});
