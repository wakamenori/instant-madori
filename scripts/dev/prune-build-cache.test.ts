import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
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
const selected = (records: CacheRecord[], mountLimitBytes: number) =>
  selectBuildCache({ records, mountLimitBytes }).map(({ id }) => id);

void test("retains mounts within the limit and selects every other unused cache kind", () => {
  const records = [
    record("mount"),
    ...(["regular", "internal", "frontend", "source.local", "source.git.checkout"] as const).map(
      (kind, i) => record(`unused${i}`, { kind }),
    ),
    record("busy", { kind: "regular", inUse: true }),
  ];
  assert.deepEqual(selected(records, 10), ["unused0", "unused1", "unused2", "unused3", "unused4"]);
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
    { Type: "unknown" },
    { CreatedAt: "bad" },
    { LastUsedAt: "2 hours ago" },
    { ID: "a|b" },
  ]) {
    assert.throws(() => parseBuildCache(inventory([{ ...rawRecord, ...invalid }])));
  }
});

void test("the CLI rejects invalid limits and unknown options before contacting Docker", async () => {
  const exec = promisify(execFile);
  for (const args of [
    ["--mount-limit-bytes", "-1"],
    ["--mount-limit-bytes", "NaN"],
    ["--mount-limit-bytes", ""],
    ["--unknown"],
  ]) {
    await assert.rejects(exec(process.execPath, ["scripts/dev/prune-build-cache.ts", ...args]));
  }
  const { stdout } = await exec(process.execPath, ["scripts/dev/prune-build-cache.ts", "--help"]);
  assert.match(stdout, /--dry-run/u);
});
