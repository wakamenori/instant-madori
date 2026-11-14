import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryRoot } from "../shared/repository.ts";
import { workerContainerIds } from "./wrangler-containers.ts";
void test("cleanup selects only this worker's declared container classes and proxies", () => {
  const suffix = "a".repeat(64);
  const names = [
    `workerd-instant-madori-GeometryContainer-${suffix}`,
    `workerd-instant-madori-GeometryContainer-${suffix}-proxy`,
    `workerd-other-GeometryContainer-${suffix}-proxy`,
    `workerd-instant-madori-staging-GeometryContainer-${suffix}-proxy`,
    `workerd-instant-madori-Other-${suffix}-proxy`,
    `prefix-workerd-instant-madori-GeometryContainer-${suffix}-proxy`,
    `workerd-instant-madori-GeometryContainer-${suffix}-proxy-extra`,
  ];
  const rows = names.map((Names, index) => ({ ID: String(index).repeat(12), Names }));
  const config = { name: "instant-madori", containers: [{ class_name: "GeometryContainer" }] };
  assert.deepEqual(workerContainerIds(config, rows.map((r) => JSON.stringify(r)).join("\n")), [
    rows[0]?.ID,
    rows[1]?.ID,
  ]);
  assert.deepEqual(workerContainerIds(config, ""), []);
  assert.throws(() => workerContainerIds(config, '{"ID":"--force","Names":"anything"}'));
  assert.throws(() => workerContainerIds(config, "broken json"));
});

void test("session cleanup preserves pre-existing containers using only fake docker", async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "madori-fake-docker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "calls");
  const listing = join(directory, "listing");
  await writeFile(
    join(directory, "docker"),
    '#!/bin/sh\necho "$@" >> "$FAKE_DOCKER_LOG"\nif [ "$1" = "ps" ]; then /bin/cat "$FAKE_DOCKER_PS"; fi\n',
    { mode: 0o755 },
  );
  const prefix = "workerd-instant-madori-GeometryContainer-";
  const rows = [
    { ID: "a".repeat(64), Names: prefix + "1".repeat(64) },
    { ID: "b".repeat(64), Names: prefix + "1".repeat(64) + "-proxy" },
    { ID: "c".repeat(64), Names: prefix + "2".repeat(64) },
    { ID: "d".repeat(64), Names: prefix + "2".repeat(64) + "-proxy" },
    { ID: "e".repeat(64), Names: "other-" + prefix + "2".repeat(64) },
  ];
  await writeFile(
    listing,
    rows
      .slice(0, 2)
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  const module = new URL("./wrangler-containers.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {writeFileSync} from "node:fs"; import {cleanupWorkerContainers, snapshotWorkerContainers} from ${JSON.stringify(module)}; const before = snapshotWorkerContainers(); writeFileSync(${JSON.stringify(listing)}, ${JSON.stringify(rows.map((r) => JSON.stringify(r)).join("\n"))}); cleanupWorkerContainers(before);`,
    ],
    {
      env: { ...process.env, PATH: directory, FAKE_DOCKER_LOG: log, FAKE_DOCKER_PS: listing },
    },
  );
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "ps -a --no-trunc --format {{json .}}",
    "ps -a --no-trunc --format {{json .}}",
    `rm --force ${"c".repeat(64)} ${"d".repeat(64)}`,
  ]);
});

void test("session cleanup freezes patterns across branch switches and snapshots every ID", async (t) => {
  const { mkdtemp, writeFile, readFile, rm, mkdir, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "madori 日本語 #% branch-switch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts/dev"), { recursive: true });
  await mkdir(join(directory, "scripts/shared"));
  await writeFile(
    join(directory, "scripts/shared/repository.ts"),
    await readFile(new URL("../shared/repository.ts", import.meta.url)),
  );
  await mkdir(join(directory, "apps/worker"), { recursive: true });
  await symlink(
    fileURLToPath(new URL("node_modules", repositoryRoot)),
    join(directory, "node_modules"),
  );
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    join(directory, "scripts/dev/wrangler-containers.ts"),
    await readFile(new URL("./wrangler-containers.ts", import.meta.url)),
  );
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "docker"),
    '#!/bin/sh\necho "$@" >> "$FAKE_DOCKER_LOG"\nif [ "$1" = "ps" ]; then /bin/cat "$FAKE_DOCKER_PS"; fi\n',
    { mode: 0o755 },
  );
  const log = join(directory, "calls");
  const listing = join(directory, "listing");
  const configPath = join(directory, "apps/worker/wrangler.jsonc");
  const config = { name: "instant-madori", containers: [{ class_name: "GeometryContainer" }] };
  await writeFile(configPath, JSON.stringify(config));
  const name = (className: string) => `workerd-instant-madori-${className}-${"1".repeat(64)}`;
  const preexisting = [
    { ID: "a".repeat(64), Names: name("JobContainer") },
    { ID: "b".repeat(64), Names: "unrelated" },
  ];
  const after = [
    preexisting[0],
    { ID: "b".repeat(64), Names: name("GeometryContainer") },
    { ID: "c".repeat(64), Names: name("GeometryContainer") + "-proxy" },
    { ID: "d".repeat(64), Names: name("JobContainer") + "-proxy" },
  ];
  await writeFile(listing, preexisting.map((row) => JSON.stringify(row)).join("\n"));
  const module = pathToFileURL(join(directory, "scripts/dev/wrangler-containers.ts")).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { writeFileSync } from "node:fs";
    import { snapshotWorkerContainers, cleanupWorkerContainers } from ${JSON.stringify(module)};
    const before = snapshotWorkerContainers();
    writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(JSON.stringify({ ...config, containers: [...config.containers, { class_name: "JobContainer" }] }))});
    writeFileSync(${JSON.stringify(listing)}, ${JSON.stringify(after.map((row) => JSON.stringify(row)).join("\n"))});
    cleanupWorkerContainers(before);
  `,
    ],
    { env: { ...process.env, PATH: bin, FAKE_DOCKER_LOG: log, FAKE_DOCKER_PS: listing } },
  );
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "ps -a --no-trunc --format {{json .}}",
    "ps -a --no-trunc --format {{json .}}",
    `rm --force ${"c".repeat(64)}`,
  ]);
});
