import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { z } from "zod";
import { parseBuildCache, selectBuildCache } from "./prune-build-cache.ts";

type CacheRecord = Parameters<typeof selectBuildCache>[0]["records"][number];
const record = (id: string, overrides: Partial<CacheRecord> = {}): CacheRecord => ({
  id,
  kind: "exec.cachemount",
  sizeBytes: 10,
  usedAt: 100,
  inUse: false,
  ...overrides,
});
const selected = (records: CacheRecord[], mountLimitBytes: number, layerLimitBytes = 0) =>
  selectBuildCache({ records, mountLimitBytes, layerLimitBytes }).map(({ id }) => id);

void test("retains mounts within the limit and removes known unused kinds with a zero layer budget", () => {
  const records = [
    record("mount"),
    ...(["regular", "internal", "frontend", "source.local", "source.git.checkout"] as const).map(
      (kind, i) => record(`unused${i}`, { kind }),
    ),
    record("busy", { kind: "regular", inUse: true }),
  ];
  assert.deepEqual(selected(records, 10).sort(), [
    "unused0",
    "unused1",
    "unused2",
    "unused3",
    "unused4",
  ]);
});

void test("retains recent regular and frontend layers within their separate budget", () => {
  const records = [
    record("mount", { sizeBytes: 10 }),
    record("rust", { kind: "regular", sizeBytes: 8, usedAt: 30 }),
    record("copy", { kind: "regular", sizeBytes: 2, usedAt: 20 }),
    record("frontend", { kind: "frontend", sizeBytes: 4, usedAt: 10 }),
    record("context", { kind: "source.local", sizeBytes: 1, usedAt: 40 }),
  ];
  assert.deepEqual(selected(records, 10, 10), ["context", "frontend"]);
  assert.deepEqual(selected(records, 0, 14), ["context", "mount"]);
  assert.deepEqual(selected(records, 10, 9), ["context", "frontend", "copy"]);
});

void test("in-use layers consume their reported budget but are never selected", () => {
  assert.deepEqual(
    selected(
      [
        record("busy", { kind: "regular", inUse: true, sizeBytes: 20 }),
        record("unused", { kind: "frontend", sizeBytes: 5 }),
      ],
      0,
      10,
    ),
    ["unused"],
  );
});

void test("unknown cache kinds are retained even with zero budgets", () => {
  assert.deepEqual(selected([record("future", { kind: "source.future" })], 0, 0), []);
});

void test("removes only the oldest unused mounts needed to reach the limit", () => {
  const records = [
    record("new", { usedAt: 30 }),
    record("old", { usedAt: 10 }),
    record("middle", { usedAt: 20 }),
  ];
  const snapshot = structuredClone(records);
  assert.deepEqual(selected(records, 20), ["old"]);
  assert.deepEqual(selected(records, 19), ["old", "middle"]);
  assert.deepEqual(records, snapshot);
});

void test("counts in-use mounts toward the limit but never selects them", () => {
  const records = [record("busy", { inUse: true, sizeBytes: 30 }), record("unused")];
  assert.deepEqual(selected(records, 20), ["unused"]);
  assert.deepEqual(selected([record("busy", { inUse: true })], 0), []);
});

void test("uses stable IDs for equal ages and handles zero and empty inventories", () => {
  assert.deepEqual(selected([record("b"), record("a")], 10), ["a"]);
  assert.deepEqual(selected([record("mount")], 0), ["mount"]);
  assert.deepEqual(selected([], 0), []);
});

const rawRecord = {
  ID: "cache123",
  Type: "exec.cachemount",
  Size: 123456789,
  InUse: false,
  CreatedAt: "2026-11-13T00:00:00.123456789Z",
  LastUsedAt: "2026-11-14T00:00:00.123456789Z",
};
const inventory = (records: unknown) => JSON.stringify({ BuildCache: records });

void test("parses exact bytes and last-use time, tolerating extra Docker fields", () => {
  assert.deepEqual(parseBuildCache(inventory([{ ...rawRecord, Description: "cache" }])), [
    record("cache123", { sizeBytes: 123456789, usedAt: Date.parse(rawRecord.LastUsedAt) }),
  ]);
  assert.deepEqual(parseBuildCache(inventory(null)), []);
  assert.deepEqual(parseBuildCache(inventory([])), []);
});

void test("falls back to creation time for never-used mounts", () => {
  const parsed = parseBuildCache(
    inventory([
      { ...rawRecord, ID: "createdlater", CreatedAt: "2026-11-13T01:00:00Z", LastUsedAt: null },
      { ...rawRecord, ID: "usedlater", CreatedAt: "2026-11-12T00:00:00Z" },
    ]),
  );
  assert.deepEqual(selected(parsed, rawRecord.Size), ["createdlater"]);
});

void test("rejects an incomplete or malformed inventory before selecting anything", () => {
  for (const output of ["not json", "{}", inventory([rawRecord, rawRecord])]) {
    assert.throws(() => parseBuildCache(output));
  }
  for (const invalid of [
    { Size: -1 },
    { Size: 1.5 },
    { Size: Number.MAX_SAFE_INTEGER + 1 },
    { Size: "10MB" },
    { InUse: "false" },
    { InUse: undefined },
    { Type: "" },
    { Type: false },
    { CreatedAt: "bad" },
    { LastUsedAt: "2 hours ago" },
    { ID: "a|b" },
    { Type: "source.future", Size: "10MB" },
  ]) {
    assert.throws(() => parseBuildCache(inventory([{ ...rawRecord, ...invalid }])));
  }
});

async function dockerFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cache-cli-"));
  const socket = join(directory, "d.sock");
  const state = join(directory, "inventory.json");
  const calls = join(directory, "calls.jsonl");
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(calls, "");
  await writeFile(
    state,
    inventory([
      { ...rawRecord, ID: "mount", Size: 8_100_000_000 },
      { ...rawRecord, ID: "abc", Type: "source.local", Size: 1 },
      { ...rawRecord, ID: "xabcy", Type: "regular", Size: 10 },
      { ...rawRecord, ID: "future", Type: "source.future", Size: 1 },
    ]),
  );
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (!args.includes("prune")) throw new Error("Unexpected fake Docker command");
const filter = args[args.indexOf("--filter") + 1];
if (!filter?.startsWith("id~=")) throw new Error("Missing ID filter");
const ids = new RegExp(filter.slice(4));
const path = ${JSON.stringify(state)};
const data = JSON.parse(readFileSync(path, "utf8"));
data.BuildCache = data.BuildCache.filter((record) => record.InUse || !ids.test(record.ID));
writeFileSync(path, JSON.stringify(data));
`,
    { mode: 0o755 },
  );
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    void readFile(state).then(
      (body) => response.end(body),
      () => {
        response.statusCode = 500;
        response.end();
      },
    );
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  const exec = promisify(execFile);
  return {
    requests,
    run(args: string[], disconnected = false) {
      return exec(process.execPath, ["scripts/dev/prune-build-cache.ts", ...args], {
        env: {
          ...process.env,
          PATH: bin,
          DOCKER_CONTEXT: "",
          DOCKER_HOST: `unix://${disconnected ? join(directory, "missing.sock") : socket}`,
        },
        timeout: 10_000,
      });
    },
    async calls() {
      const lines = (await readFile(calls, "utf8")).trim();
      return lines
        ? lines.split("\n").map((line) => z.array(z.string()).parse(JSON.parse(line)))
        : [];
    },
    async records() {
      return parseBuildCache(await readFile(state, "utf8"));
    },
  };
}

void test("CLI validation rejects invalid limits before contacting a disconnected Docker", async (t) => {
  const fixture = await dockerFixture(t);
  for (const option of ["mount-limit-bytes", "layer-limit-bytes"]) {
    for (const value of ["-1", "NaN", "", "1.5", "9007199254740993", "1e9"]) {
      await assert.rejects(
        fixture.run(["--dry-run", `--${option}=${value}`], true),
        (error: unknown) => {
          assert(error instanceof Error && "stderr" in error);
          assert.equal(typeof error.stderr, "string");
          assert.match(
            String(error.stderr),
            /Invalid Docker cache inventory, local Unix socket or cache limit/u,
          );
          assert.doesNotMatch(String(error.stderr), /ENOENT|ECONNREFUSED/u);
          return true;
        },
      );
    }
  }
  await assert.rejects(fixture.run(["--dry-run", "--unknown"], true), /Unknown option/u);
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual(fixture.requests, []);
  const { stdout } = await fixture.run(["--help"], true);
  assert.match(stdout, /--dry-run/u);
});

void test("CLI dry-run keeps the daemon unchanged and reports exact GiB defaults and unknown kinds", async (t) => {
  const fixture = await dockerFixture(t);
  const before = await fixture.records();
  const { stdout } = await fixture.run(["--dry-run"]);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  const unknown = z
    .object({ event: z.literal("docker.cache.prune.unknown"), retainedKinds: z.array(z.string()) })
    .parse(JSON.parse(lines[0] ?? ""));
  assert.deepEqual(unknown.retainedKinds, ["source.future"]);
  const plan = z
    .object({
      event: z.literal("docker.cache.prune.plan"),
      dryRun: z.literal(true),
      mountLimitBytes: z.literal(8 * 1024 ** 3),
      layerLimitBytes: z.literal(4 * 1024 ** 3),
      remove: z.array(z.object({ id: z.string() })),
    })
    .parse(JSON.parse(lines[1] ?? ""));
  assert.deepEqual(
    plan.remove.map(({ id }) => id),
    ["abc"],
  );
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual(await fixture.records(), before);
  assert.deepEqual(fixture.requests, ["/v1.51/system/df?type=build-cache"]);
});

void test("CLI apply sends an anchored ID filter that cannot delete a retained substring match", async (t) => {
  const fixture = await dockerFixture(t);
  await fixture.run([]);
  assert.deepEqual(
    (await fixture.records()).map(({ id }) => id),
    ["mount", "xabcy", "future"],
  );
  const calls = await fixture.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(2), [
    "buildx",
    "prune",
    "--builder",
    "default",
    "--all",
    "--force",
    "--filter",
    "id~=^(abc)$",
  ]);
});
