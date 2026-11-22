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
  parents: [],
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
  assert.deepEqual(selected(records, 10, 10), ["frontend", "context"]);
  assert.deepEqual(selected(records, 0, 14), ["context", "mount"]);
  assert.deepEqual(selected(records, 10, 9), ["frontend", "copy", "context"]);
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

void test("retains both parents of a kept merge and charges blocked layers to their budget", () => {
  const records = [
    record("base", { kind: "regular", sizeBytes: 50 }),
    record("context", { kind: "source.local" }),
    record("merge", { kind: "regular", parents: ["base", "context"] }),
    record("mount", { parents: ["merge"] }),
    record("older", { kind: "frontend", usedAt: 101 }),
    record("newer", { kind: "regular", usedAt: 102 }),
  ];
  assert.deepEqual(selected(records, 10, 70), ["older"]);
});

void test("protects ancestors of in-use and unknown descendants at zero budget", () => {
  for (const overrides of [{ inUse: true }, { kind: "source.future" }]) {
    const records = [
      record("root"),
      record("mid", { parents: ["root"], kind: "internal" }),
      record("leaf", { parents: ["mid"], ...overrides }),
    ];
    assert.deepEqual(selected(records, 0), []);
  }
});

void test("orders whole trees and sibling branches by newest descendant use", () => {
  const records = [
    record("base", { kind: "regular", usedAt: 1, sizeBytes: 100 }),
    record("stale", { kind: "regular", usedAt: 20, parents: ["base"] }),
    record("fresh", { kind: "regular", usedAt: 30, parents: ["base"] }),
    record("variant", { kind: "regular", usedAt: 3 }),
    record("tip", { kind: "regular", usedAt: 10, parents: ["variant"] }),
  ];
  const removed = selected(records, 0, 110);
  assert.deepEqual(removed, ["tip", "variant", "stale"]);
  assert.deepEqual(selected([...records].reverse(), 0, 110), removed);
  assert.deepEqual(
    selected(
      records.filter((r) => !removed.includes(r.id)),
      0,
      110,
    ),
    [],
  );
});

void test("after a Rust base bump, 6 GiB removes the older set's build chain through its apt RUN", () => {
  // Layer sizes of the geometry image measured on 2026-11-22, root first.
  const buildChain = [
    ["rust1", 203_786_022],
    ["rust2", 75_074_838],
    ["rust3", 264_966_221],
    ["rust4", 795_424_060],
    ["rust5", 728_378_330],
    ["workdirsrc", 8_284],
    ["toolchain", 12_525],
    ["apt", 642_584_516],
    ["cargotoml", 154_635],
    ["dotcargo", 16_384],
    ["geometry", 57_344],
    ["crates", 364_544],
    ["solidcraft", 139_374_592],
    ["workdirapp", 8_192],
    ["cargorun", 234_049_536],
  ] as const;
  const shared = [
    record("runtimebase", { kind: "regular", sizeBytes: 113_551_278, usedAt: 2 }),
    record("groupadd", { kind: "regular", sizeBytes: 81_119, usedAt: 2, parents: ["runtimebase"] }),
    record("frontend", { kind: "frontend", sizeBytes: 41_852_167, usedAt: 4 }),
  ];
  // BuildKit stamps a build's final stage last, and a fully cached build stamps only that stage.
  const set = (name: string, buildAt: number, finalAt: number) => [
    ...buildChain.map(([step, sizeBytes], i) =>
      record(`${name}${step}`, {
        kind: "regular",
        sizeBytes,
        usedAt: buildAt,
        parents: i === 0 ? [] : [`${name}${buildChain[i - 1]?.[0] ?? ""}`],
      }),
    ),
    record(`${name}copyfrombuild`, {
      kind: "regular",
      sizeBytes: 308_441_272,
      usedAt: finalAt,
      parents: ["groupadd"],
    }),
  ];
  const bytes = (records: CacheRecord[]) => records.reduce((sum, r) => sum + r.sizeBytes, 0);
  const older = set("old", 1, 2);
  const records = [...older, ...set("new", 3, 4), ...shared];
  assert.equal(bytes([...older, ...shared]), 3_548_185_859);
  assert.equal(bytes(records), 6_940_887_154);

  const removed = selected(records, 0, 6 * 1024 ** 3);
  assert.deepEqual(removed, [
    "oldcargorun",
    "oldworkdirapp",
    "oldsolidcraft",
    "oldcrates",
    "oldgeometry",
    "olddotcargo",
    "oldcargotoml",
    "oldapt",
  ]);
  assert.equal(bytes(records.filter((r) => removed.includes(r.id))), 1_016_609_743);
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

void test("combines both Docker parent keys and drops duplicates and absent IDs", () => {
  const records = parseBuildCache(
    inventory([
      { ...rawRecord, ID: "a", Parents: null },
      { ...rawRecord, ID: "b", " Parents": null },
      { ...rawRecord, " Parents": ["a", "missing"], Parents: ["a", "b"] },
    ]),
  );
  assert.deepEqual(
    records.map((r) => r.parents),
    [[], [], ["a", "b"]],
  );
});

void test("rejects self-parent and multi-record cycles", () => {
  for (const rows of [
    [{ ...rawRecord, Parents: [rawRecord.ID] }],
    [
      { ...rawRecord, ID: "a", Parents: ["b"] },
      { ...rawRecord, ID: "b", " Parents": ["a"] },
    ],
  ])
    assert.throws(() => parseBuildCache(inventory(rows)), /cycle/iu);
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
    { Parents: "bad" },
    { " Parents": ["a|b"] },
    { Type: "source.future", Size: "10MB" },
  ]) {
    assert.throws(() => parseBuildCache(inventory([{ ...rawRecord, ...invalid }])));
  }
});

async function dockerFixture(
  t: TestContext,
  records = [
    { ...rawRecord, ID: "mount", Size: 8_100_000_000 },
    { ...rawRecord, ID: "abc", Type: "source.local", Size: 1 },
    { ...rawRecord, ID: "xabcy", Type: "regular", Size: 10 },
    { ...rawRecord, ID: "future", Type: "source.future", Size: 1 },
  ],
) {
  const directory = await mkdtemp(join(tmpdir(), "cache-cli-"));
  const socket = join(directory, "d.sock");
  const state = join(directory, "inventory.json");
  const calls = join(directory, "calls.jsonl");
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(calls, "");
  await writeFile(state, inventory(records));
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
while (true) {
  const parents = new Set(data.BuildCache.flatMap(r => [...(r[" Parents"] ?? []), ...(r.Parents ?? [])]));
  const keep = data.BuildCache.filter(r => r.InUse || parents.has(r.ID) || !ids.test(r.ID));
  if (keep.length === data.BuildCache.length) break;
  data.BuildCache = keep;
}
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
      layerLimitBytes: z.literal(6 * 1024 ** 3),
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

void test("CLI apply reaches the layer limit with dependent layers", async (t) => {
  const base = {
    ...rawRecord,
    ID: "base",
    Type: "regular",
    Size: 100,
    LastUsedAt: rawRecord.CreatedAt,
  };
  const stale = { ...rawRecord, ID: "stale", Type: "regular", Size: 4, " Parents": ["base"] };
  const fresh = { ...stale, ID: "fresh", LastUsedAt: "2026-11-15T00:00:00Z" };
  const fixture = await dockerFixture(t, [base, stale, fresh]);
  const { stdout } = await fixture.run(["--layer-limit-bytes=104"]);
  const lines = stdout.trim().split("\n");
  const result = z
    .object({
      event: z.literal("docker.cache.prune.result"),
      after: z.object({ layerBytes: z.number() }),
      notRemoved: z.array(z.string()).optional(),
    })
    .parse(JSON.parse(lines.at(-1) ?? ""));
  assert.equal(result.after.layerBytes, 104);
  assert.deepEqual(result.notRemoved, []);
  const ranked = z.object({ id: z.string(), subtreeUsedAt: z.number() });
  const plan = z
    .object({
      event: z.literal("docker.cache.prune.plan"),
      expectedAfter: z.object({ layerBytes: z.number() }),
      remove: z.array(ranked),
      keep: z.array(ranked),
    })
    .parse(JSON.parse(lines[0] ?? ""));
  assert.equal(plan.expectedAfter.layerBytes, result.after.layerBytes);
  assert.deepEqual(plan.remove, [{ id: stale.ID, subtreeUsedAt: Date.parse(stale.LastUsedAt) }]);
  assert.equal(
    plan.keep.find((r) => r.id === base.ID)?.subtreeUsedAt,
    Date.parse(fresh.LastUsedAt),
  );
});
