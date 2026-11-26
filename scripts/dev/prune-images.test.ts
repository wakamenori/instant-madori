import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  parseImages,
  parseSessionsSince,
  parseToleratedErrors,
  planImageRetention,
} from "./prune-images.ts";

const dev = "cloudflare-dev/geometrycontainer-geometry-8788ff521eb5";
const staging = `registry.cloudflare.com/${"a".repeat(32)}/instant-madori-staging-geometrycontainer-geometry`;
const image = (n: number, lastTaggedAt: number | undefined) => ({
  id: `sha256:${String(n).padStart(64, "0")}`,
  references: [`${dev}:a${n}`, `${dev}:b${n}`],
  lastTaggedAt,
});

void test("only owned tags enter the plan, including on images shared with other repositories", () => {
  const shared = image(1, 1);
  const raw = {
    Id: shared.id,
    RepoTags: [
      `${staging}:one`,
      "<none>:<none>",
      `${dev}:one`,
      `${dev}-other:one`,
      `${staging}-other:one`,
      `${dev}@${shared.id}`,
    ],
    Metadata: { LastTagTime: "2026-11-21T12:00:00Z" },
  };
  const images = parseImages(
    JSON.stringify([raw, { Id: image(3, 1).id, RepoTags: ["other/project:one"] }]),
  );
  const decisions = planImageRetention({
    images: [...images, image(2, Date.UTC(2027, 0))],
    keep: 1,
    containerImageIds: new Set(),
    sessionsSince: undefined,
  });
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[1], {
    id: shared.id,
    kind: "removed",
    kept: [],
    untagged: [`${dev}:one`, `${staging}:one`],
  });
});

void test("newest IDs keep one tag, ties use ID order, and older IDs lose every tag", () => {
  const [a, b, c] = [image(1, 2), image(2, 2), image(3, 3)] as const;
  const result = planImageRetention({
    images: [b, a, c],
    keep: 2,
    containerImageIds: new Set(),
    sessionsSince: undefined,
  });
  assert.deepEqual(result, [
    { id: c.id, kind: "retained", kept: c.references.slice(0, 1), untagged: c.references.slice(1) },
    { id: a.id, kind: "retained", kept: a.references.slice(0, 1), untagged: a.references.slice(1) },
    { id: b.id, kind: "removed", kept: [], untagged: b.references },
  ]);
});

void test("container use, unknown time and the inclusive session cutoff protect every tag", () => {
  const images = [
    image(1, undefined),
    image(2, undefined),
    image(3, 20),
    image(4, 10),
    image(5, 9),
  ];
  const decisions = planImageRetention({
    images,
    keep: 1,
    containerImageIds: new Set([image(1, 0).id]),
    sessionsSince: 10,
  });
  assert.deepEqual(
    decisions.map((d) => (d.kind === "protected" ? d.reason : d.kind)),
    ["container", "unknown-tag-time", "session", "session", "removed"],
  );
  for (const [i, decision] of decisions.slice(0, 4).entries()) {
    assert.deepEqual(decision.kept, images[i]?.references);
    assert.deepEqual(decision.untagged, []);
  }
});

void test("elapsed process times use the oldest Wrangler CLI start and the clock margin", () => {
  const now = Date.UTC(2026, 0);
  const unrelated = "30-10:00:00 node wrangler dev";
  assert.equal(parseSessionsSince(unrelated, now), undefined);
  for (const [etime, seconds] of [
    ["00:23", 23],
    ["01:02:03", 3723],
    ["02-01:02:03", 176523],
  ] as const) {
    assert.equal(
      parseSessionsSince(
        `${unrelated}\n00:01 wrangler-dist/cli.js\n  ${etime} node x/wrangler-dist/cli.js dev\n`,
        now,
      ),
      now - (seconds + 300) * 1000,
    );
  }
  assert.throws(() => parseSessionsSince("bad wrangler-dist/cli.js", now));
});

void test("missing and zero LastTagTime stay unknown and malformed inventories fail", () => {
  const row = { Id: image(1, 1).id, RepoTags: [`${dev}:one`] };
  for (const Metadata of [undefined, {}, { LastTagTime: "0001-01-01T00:00:00Z" }]) {
    assert.equal(parseImages(JSON.stringify([{ ...row, Metadata }]))[0]?.lastTaggedAt, undefined);
  }
  for (const bad of [
    null,
    [{}],
    [{ ...row, Id: "short" }],
    [{ ...row, Metadata: { LastTagTime: "yesterday" } }],
    [row, row],
    [row, { ...row, Id: image(2, 1).id }],
  ]) {
    assert.throws(() => parseImages(JSON.stringify(bad)));
  }
});

void test("only Docker delete conflicts and vanished objects are tolerated", () => {
  const conflict = "Error response from daemon: conflict: unable to delete image (must be forced)";
  const missing = "Error response from daemon: No such image: repo:tag";
  const gone = "Error response from daemon: No such container: " + "0".repeat(64);
  const removal = /^Error response from daemon: (?:conflict: unable to delete\b|No such image: )/u;
  const inventory = /^Error response from daemon: No such (?:image|container): /u;
  assert.deepEqual(parseToleratedErrors(conflict + "\n" + missing, removal), [conflict, missing]);
  assert.deepEqual(parseToleratedErrors(gone + "\n" + missing, inventory), [gone, missing]);
  for (const other of ["", missing + "\nconnection lost", "failed: No such image: repo:tag"])
    assert.throws(() => parseToleratedErrors(other, removal));
  assert.throws(() => parseToleratedErrors(conflict, inventory));
});

function runPrune(docker: string, ps: string, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "prune-images-"));
  try {
    for (const [name, script] of [
      ["docker", docker],
      ["ps", ps],
    ] as const) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    }
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./prune-images.ts", import.meta.url)), ...args],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: dir + delimiter + (process.env.PATH ?? "") },
      },
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
}

void test("carried ps durations protect Wrangler sessions at hour and day boundaries", () => {
  const now = Date.UTC(2026, 0);
  assert.equal(parseSessionsSince("      60:00 node x/wrangler-dist/cli.js", now), now - 3900_000);
  assert.equal(parseSessionsSince("   24:00:00 node x/wrangler-dist/cli.js", now), now - 86700_000);
});

void test("pruning reports the Wrangler cutoff when macOS ps prints 60:00", () => {
  const start = Date.now();
  const run = runPrune(
    "exit 0",
    "echo '      60:00 /usr/libexec/coreduetd'\necho '      60:00 node x/wrangler-dist/cli.js'",
    "--dry-run",
  );
  const end = Date.now();
  assert.equal(run.status, 0, run.stderr);
  const plan = z
    .object({ event: z.literal("docker.images.prune.plan"), sessionsSince: z.iso.datetime() })
    .parse(JSON.parse(run.stdout));
  const sessionNow = Date.parse(plan.sessionsSince) + 3900_000;
  assert.ok(start <= sessionNow && sessionNow <= end);
});
