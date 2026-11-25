import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { tryLock } from "../shared/docker-slots.ts";
import {
  capBytes,
  claimAndEmpty,
  findHolder,
  measure,
  parseProcesses,
  parseRunnerConfig,
  planReclaim,
  quietMs,
  type Measured,
} from "./prune-targets.ts";

const gitHubUrl = "https://github.com/wakamenori/instant-madori";
void test("runner discovery validates BOM-prefixed config, work folders and repository", () => {
  for (const [folder, target] of [
    ["_work", "/runner/_work"],
    ["/work", "/work"],
  ] as const) {
    const config = { agentName: "ci-1", gitHubUrl, workFolder: folder, other: 1 };
    assert.deepEqual(parseRunnerConfig("\uFEFF" + JSON.stringify(config), "/runner"), {
      id: "runner:ci-1",
      kind: "runner",
      runnerRoot: "/runner",
      target: target + "/_tool/madori/target",
    });
    assert.equal(
      parseRunnerConfig(
        JSON.stringify({ ...config, gitHubUrl: "https://github.com/other/repo" }),
        "/runner",
      ),
      undefined,
    );
    for (const invalid of [{ agentName: "../ci" }, { workFolder: "" }])
      assert.throws(() => parseRunnerConfig(JSON.stringify({ ...config, ...invalid }), "/runner"));
  }
});
void test("process list accepts whitespace and rejects malformed rows", () => {
  for (const row of ["23 /bin/cargo build", "\n   23   /bin/cargo build\n \n"])
    assert.deepEqual(parseProcesses(row), [{ pid: 23, command: "/bin/cargo build" }]);
  assert.throws(() => parseProcesses("23 /bin/cargo\nmalformed"));
});

const main: Measured = {
  kind: "checkout",
  id: "main",
  target: "/main/target",
  bytes: 1,
  oldestBirthMs: 0,
  newestWriteMs: 0,
};
const runner: Measured = {
  kind: "runner",
  id: "runner:ci",
  runnerRoot: "/ci",
  target: "/ci/target",
  bytes: 2,
  oldestBirthMs: 0,
  newestWriteMs: 0,
};
void test("plan orders over-cap, checkout, largest eligible runners, then keeps", () => {
  const heaps: Measured[] = [
    runner,
    { ...runner, id: "runner:empty", bytes: 0 },
    { ...runner, id: "runner:fresh", oldestBirthMs: quietMs - 3_600_000 },
    main,
    { ...runner, id: "runner:cap", bytes: capBytes },
    { ...runner, id: "runner:over", bytes: capBytes + 1, oldestBirthMs: quietMs },
  ];
  assert.deepEqual(
    planReclaim(heaps, quietMs).map(({ heap, ...decision }) => [heap.id, decision]),
    [
      ["runner:over", { action: "over-cap" }],
      ["main", { action: "low-disk" }],
      ["runner:cap", { action: "low-disk" }],
      ["runner:ci", { action: "low-disk" }],
      ["runner:empty", { action: "keep", reason: "empty" }],
      ["runner:fresh", { action: "keep", reason: "refilled-recently" }],
    ],
  );
});
void test("holder distinguishes worker roots, ignores self and protects recent checkout writes", () => {
  for (const [heap, pid, command, now, holder] of [
    [runner, 2, "/ci/bin/Runner.Worker spawn", 0, { kind: "runner-job", pid: 2 }],
    [runner, 2, "/other/bin/Runner.Worker spawn", 0, undefined],
    [
      runner,
      2,
      "cargo --target-dir /ci/target",
      0,
      { kind: "process", pid: 2, command: "cargo --target-dir /ci/target" },
    ],
    [runner, 1, "inspect /ci/target", 0, undefined],
    [main, 2, "cargo build", quietMs - 1, { kind: "recent-write", at: new Date(0).toISOString() }],
    [main, 2, "cargo build", quietMs, undefined],
  ] as const)
    assert.deepEqual(findHolder(heap, [{ pid, command }], now, 1), holder);
});

const mac = { skip: process.platform !== "darwin" };
const lockNames = [
  "debug/.cargo-artifact-lock",
  "debug/.cargo-build-lock",
  "debug/.cargo-lock",
  "wasm32-unknown-unknown/release/.cargo-lock",
];
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "prune-targets-"));
  t.after(() => rmSync(root, { recursive: true }));
  const target = join(root, "target");
  for (const dir of [
    "debug/deps",
    "debug/.fingerprint/x-0123456789abcdef",
    "wasm32-unknown-unknown/release",
  ])
    mkdirSync(join(target, dir), { recursive: true });
  for (const lock of lockNames) writeFileSync(join(target, lock), "");
  const artifact = join(target, "debug/deps/artifact");
  writeFileSync(artifact, "artifact");
  linkSync(artifact, join(target, "debug/.fingerprint/x-0123456789abcdef/artifact"));
  const outside = join(root, "outside");
  writeFileSync(outside, "untouched");
  symlinkSync(outside, join(target, "outside-link"));
  return { root, target, outside, artifact, heap: { ...runner, target } };
}
void test(
  "measurement counts allocated blocks once and refuses symlink or file targets",
  mac,
  (t) => {
    const { heap, target, artifact, outside } = fixture(t);
    const stat = lstatSync(artifact);
    const measured = measure(heap);
    assert.equal(measured.bytes, stat.blocks * 512);
    assert.ok(Math.abs((measured.newestWriteMs ?? Infinity) - stat.mtimeMs) < 0.001);
    assert.ok(Math.abs((measured.oldestBirthMs ?? Infinity) - stat.birthtimeMs) < 0.001);
    for (const path of [outside, join(target, "outside-link")])
      assert.throws(() => measure({ ...heap, target: path }), {
        message: `Expected target directory at ${path}`,
      });
    const missing = { ...heap, target: join(target, "absent") };
    assert.deepEqual(measure(missing), {
      ...missing,
      bytes: 0,
      newestWriteMs: undefined,
      oldestBirthMs: undefined,
    });
  },
);
const entries = (target: string) =>
  readdirSync(target, { recursive: true, encoding: "utf8" }).sort();
void test(
  "empty keeps lock inodes and their ancestors and leaves the symlink destination intact",
  mac,
  async (t) => {
    const { heap, target, outside } = fixture(t);
    const inodes = () =>
      lockNames.map((name) => lstatSync(join(target, name), { bigint: true }).ino);
    const before = inodes();
    assert.equal(await claimAndEmpty(heap, () => []), undefined);
    assert.deepEqual(inodes(), before);
    assert.deepEqual(
      entries(target),
      [...lockNames, "debug", "wasm32-unknown-unknown", "wasm32-unknown-unknown/release"].sort(),
    );
    assert.equal(readFileSync(outside, "utf8"), "untouched");
  },
);

function childLocker(t: TestContext, root: string, lock: string) {
  const child = spawn(process.execPath, [
    "-e",
    `
    const fs = require("node:fs");
    const [root, lock] = process.argv.slice(1);
    fs.writeFileSync(root + "/opening", "");
    fs.openSync(lock, fs.constants.O_RDWR | 0x20);
    fs.writeFileSync(root + "/held", "");
    process.stdin.resume();
  `,
    root,
    lock,
  ]);
  t.after(() => {
    child.kill();
  });
  return async (marker: string) => {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, marker))) {
      assert.equal(child.exitCode, null);
      assert.ok(Date.now() < deadline, `Child timed out waiting for ${marker}`);
      await sleep(10);
    }
  };
}
void test("cargo lock held by another process leaves the heap intact", mac, async (t) => {
  const { root, heap, target } = fixture(t);
  const lock = join(target, "debug/.cargo-lock");
  const before = entries(target);
  await childLocker(t, root, lock)("held");
  assert.deepEqual(await claimAndEmpty(heap, () => assert.fail("process snapshot before claim")), {
    kind: "cargo-lock",
    lock,
  });
  assert.deepEqual(entries(target), before);
  const fd = tryLock(join(target, "debug/.cargo-artifact-lock"));
  assert.notEqual(fd, undefined);
  if (fd !== undefined) closeSync(fd);
});
void test("waiting cargo acquires the lock at the same path after reclaim", mac, async (t) => {
  const { root, heap, target } = fixture(t);
  const lock = join(target, "debug/.cargo-build-lock");
  let held: Promise<void> | undefined;
  assert.equal(
    await claimAndEmpty(heap, async () => {
      const wait = childLocker(t, root, lock);
      await wait("opening");
      await sleep(50);
      assert.equal(existsSync(join(root, "held")), false);
      held = wait("held");
      return [];
    }),
    undefined,
  );
  await held;
  assert.equal(tryLock(lock), undefined);
});

void test("a lock created during the process snapshot survives reclaim", mac, async (t) => {
  const { heap, target } = fixture(t);
  const lock = join(target, "debug/.cargo-new-lock");
  await assert.rejects(
    claimAndEmpty(heap, () => {
      writeFileSync(lock, "");
      return [];
    }),
    { message: `Cargo lock appeared during reclaim: ${lock}` },
  );
  assert.ok(lstatSync(lock).isFile());
});
