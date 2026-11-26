import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { metricsHome } from "../home.ts";
import { candidate } from "../ingest/polled.ts";
import { openL1Writer } from "../l1/store.ts";
import { registry } from "../l1/sources.ts";
import { parseRunSpan } from "../ingest/run-span.ts";
import { startReceiver } from "../receiver/receiver.ts";

function fixture(t: TestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-span-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".git"));
  const env = { INSTANT_MADORI_METRICS_HOME: cwd, T3CODE_THREAD_ID: "actor" };
  const home = metricsHome(env);
  const args = [
    join(import.meta.dirname, "run-span.ts"),
    "check",
    "--",
    process.execPath,
    "child.cjs",
    "--fast",
  ];
  return { cwd, env, home, args };
}

void test("only opted-in local commands publish, preserving arguments and failure status", async (t) => {
  const { cwd, env, home, args } = fixture(t);
  writeFileSync(join(cwd, "child.cjs"), 'process.exit(process.argv[2] === "--fast" ? 3 : 1)');
  const run = (extra = {}) =>
    spawnSync(process.execPath, args, { cwd, env: { ...env, ...extra } }).status;
  assert.equal(run(), 3);
  assert.equal(existsSync(home.ready), false);
  mkdirSync(home.ready, { recursive: true });
  assert.equal(run(), 3);
  assert.deepEqual(readdirSync(home.ready), []);
  mkdirSync(home.tmp);
  assert.equal(run({ GITHUB_ACTIONS: "true" }), 3);
  assert.deepEqual(readdirSync(home.ready), []);
  assert.equal(run(), 3);
  const files = readdirSync(home.ready);
  assert.equal(files.length, 1);
  const bytes = readFileSync(join(home.ready, String(files[0])));
  const identity = join(cwd, ".git");
  const record = parseRunSpan(bytes, identity).records[0];
  assert.ok(record);
  assert.equal(files[0], "run-span-" + record.naturalKey + ".json");
  assert.equal(record.payload.name, "check");
  assert.equal(record.payload.exit_code, 3);
  assert.equal(record.payload.signal, null);
  assert.deepEqual(record.payload.args, ["--fast"]);
  assert.equal(record.payload.cwd, cwd);
  assert.equal(record.payload.thread, "actor");
  assert.equal(record.payload.project, undefined);
  assert.deepEqual(parseRunSpan(bytes, "/foreign").drops, [
    { source: "run.span", reason: "foreign" },
  ]);
  assert.equal(parseRunSpan(Buffer.from("{}"), identity).rejects[0]?.reason, "invalid_run_span");
  const receiver = await startReceiver({
    home,
    identity,
    port: 0,
    pollers: [],
    rebuild: false,
    t3File: join(cwd, "missing"),
  });
  try {
    receiver.flush();
    const db = new DatabaseSync(home.database, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) n FROM l1_record WHERE source='run.span'").get()?.n,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await receiver.close();
  }
});

void test("build and setup pass user arguments to the final command of the chain", (t) => {
  const { cwd, env, home } = fixture(t);
  mkdirSync(home.ready, { recursive: true });
  mkdirSync(home.tmp);
  const flags = ["two words", "--", "a'b"];
  for (const name of ["build", "setup"]) {
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "run-span.ts"),
        name,
        "--",
        "sh",
        "-c",
        'true && printf "%s\\n" "$@"',
        name,
        ...flags,
      ],
      { cwd, env: { ...env, PATH: process.env.PATH }, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, flags.join("\n") + "\n");
  }
  const records = readdirSync(home.ready).flatMap(
    (file) => parseRunSpan(readFileSync(join(home.ready, file)), join(cwd, ".git")).records,
  );
  assert.deepEqual(records.map((record) => record.payload.name).sort(), ["build", "setup"]);
  for (const record of records) assert.deepEqual(record.payload.args, flags);
});

void test(
  "SIGTERM reaches the running command and its signal is spooled",
  { timeout: 10000 },
  async (t) => {
    const { cwd, env, home, args } = fixture(t);
    mkdirSync(home.ready, { recursive: true });
    mkdirSync(home.tmp);
    writeFileSync(join(cwd, "child.cjs"), 'console.log("ready"); setInterval(() => {}, 1000)');
    const wrapper = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const closed = once(wrapper, "close");
    await once(wrapper.stdout, "data");
    wrapper.kill("SIGTERM");
    assert.deepEqual(await closed, [143, null]);
    const files = readdirSync(home.ready);
    assert.equal(files.length, 1);
    const bytes = readFileSync(join(home.ready, String(files[0])));
    const record = parseRunSpan(bytes, join(cwd, ".git")).records[0];
    assert.equal(record?.payload.signal, "SIGTERM");
    assert.equal(record?.payload.exit_code, null);
  },
);

void test("derived commands select one actor from the explicit thread or latest matching run", (t) => {
  const { cwd, home, env } = fixture(t);
  const start = "2026-11-24T13:00:00.000Z";
  const end = "2026-11-24T13:01:00.000Z";
  const l1 = openL1Writer(home.database, registry);
  try {
    l1.ingest(
      [
        ...Object.entries({
          owner: "2026-11-24T10:00:00.000Z",
          child: "2026-11-24T11:00:00.000Z",
          future: end,
          neighbor: start,
        }).flatMap(([id, startedAt]) => [
          candidate("t3.thread", id, start, {
            created_at: start,
            issue: 558,
            title_kind: id === "owner" ? "owner" : "other",
            parent_thread_id: id === "owner" ? null : "owner",
            provider: "codex",
            worktree_path: id === "neighbor" ? cwd.slice(0, -1) : cwd,
          }),
          candidate("t3.run", id, start, {
            thread_id: id,
            started_at: startedAt,
          }),
        ]),
        ...Object.entries({ check: null, setup: "owner" }).map(([name, thread]) =>
          candidate("run.span", name, start, {
            name,
            thread,
            cwd: join(cwd, "apps"),
            started_at: start,
            ended_at: end,
            exit_code: 0,
          }),
        ),
      ],
      end,
    );
  } finally {
    l1.close();
  }
  execFileSync(process.execPath, [join(import.meta.dirname, "../build/build.ts")], {
    env: { ...process.env, ...env },
  });
  const derived = new DatabaseSync(join(cwd, "metrics-derived.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(
      derived
        .prepare(
          "SELECT actor,issue,start,end,detail FROM span WHERE kind='local_run' ORDER BY detail",
        )
        .all()
        .map(Object.values),
      [
        ["child", 558, start, end, "run:check exit 0"],
        ["owner", 558, start, end, "run:setup exit 0"],
      ],
    );
  } finally {
    derived.close();
  }
});
