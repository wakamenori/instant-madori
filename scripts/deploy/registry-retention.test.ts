import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { collectVersions, runRetention, selectTags } from "./registry-retention.ts";

const account = "4a67230af28ec94d9c70ca48572d8e9f";
const repository = "instant-madori-staging-geometrycontainer-geometry";
const other = "other-project";
const body = (n: number) => new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, id: n }));
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = (n: number) => hash(body(n));
const ref = (n: number, repo = repository) =>
  `registry.cloudflare.com/${account}/${repo}@${digest(n)}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const version = (n: number, imageRefs = [ref(n)]) => ({
  id: id(n),
  createdOn: new Date(Date.UTC(2026, 0, n)).toISOString(),
  imageRefs,
});
const tag = (n: number, name = `tag-${n}`, repo = repository) => ({
  tag: `${repo}:${name}`,
  digest: digest(n),
  preparedFrom: null,
});
const versions = Array.from({ length: 12 }, (_, i) => version(12 - i));
const input = {
  versions,
  currentIds: new Set([id(12)]),
  retain: 10,
  tags: [tag(12), tag(3), tag(2), tag(1)],
};

await test("keeps the latest ten versions and removes only exclusively older digests", () => {
  const plan = selectTags(input);
  assert.equal(plan.kind, "ready");
  if (plan.kind !== "ready") return;
  assert.deepEqual(plan.keep, [tag(12), tag(3)]);
  assert.deepEqual(plan.remove, [tag(2), tag(1)]);
});

await test("protects every current deployment version even outside the latest ten", () => {
  const plan = selectTags({ ...input, currentIds: new Set([id(12), id(1)]) });
  assert.equal(plan.kind, "ready");
  if (plan.kind !== "ready") return;
  assert.deepEqual(plan.keep, [tag(12), tag(3), tag(1)]);
  assert.deepEqual(plan.remove, [tag(2)]);
});

await test("protects aliases and old versions sharing a retained digest, reports unreferenced tags, ignores other repositories", () => {
  const alias = tag(12, "alias");
  const unreferenced = tag(99);
  const foreign = tag(1, "foreign", other);
  const plan = selectTags({
    ...input,
    versions: [...versions.slice(0, 11), version(1, [ref(12)])],
    tags: [...input.tags, alias, unreferenced, foreign],
  });
  assert.equal(plan.kind, "ready");
  if (plan.kind !== "ready") return;
  assert.deepEqual(plan.keep, [tag(12), tag(3), alias]);
  assert.deepEqual(plan.remove, [tag(2)]);
  assert.deepEqual(plan.unreferenced, [tag(1), unreferenced]);
});

await test("the repository comes from retained references; an old foreign repository cannot select tags", () => {
  const plan = selectTags({
    ...input,
    versions: [...versions.slice(0, 11), version(1, [ref(1, other)])],
    tags: [tag(2), tag(1, "foreign", other)],
  });
  assert.equal(plan.kind, "ready");
  assert.deepEqual(plan.remove, [tag(2)]);
});

await test("digest entries follow their prepared source or their own digest", () => {
  const byDigest = (n: number) => tag(n, digest(n));
  const prepared = (n: number, source: number) => ({
    ...byDigest(n),
    preparedFrom: digest(source),
  });
  const tags = [prepared(20, 12), prepared(21, 1), prepared(22, 99), byDigest(12), byDigest(1)];
  assert.deepEqual(selectTags({ ...input, tags }), {
    kind: "ready",
    repository,
    keep: [tags[0], tags[3]],
    remove: [tags[1], tags[4]],
    unreferenced: [tags[2]],
  });
});

for (const [name, overrides] of [
  ["unreadable digest", { tags: [...input.tags, { ...tag(1, "unreadable"), digest: null }] }],
  ["malformed digest", { tags: [{ ...tag(1, "broken"), digest: "sha256:broken" }] }],
  [
    "two retained repositories",
    { versions: [version(12, [ref(12), ref(12, other)]), ...versions.slice(1)] },
  ],
  ["no retained repository", { versions: versions.map((v) => ({ ...v, imageRefs: [] })) }],
  ["unknown current version", { currentIds: new Set([id(99)]) }],
  ["missing deployment versions", { currentIds: new Set<string>() }],
  ["unordered versions", { versions: [...versions].reverse() }],
  ["duplicate versions", { versions: [version(12), ...versions] }],
  ["digest name differs from manifest digest", { tags: [tag(1, digest(2))] }],
  ["duplicate tags", { tags: [tag(1), tag(1)] }],
  [
    "foreign account",
    { versions: [version(12, [ref(12).replace(account, "0".repeat(32))]), ...versions.slice(1)] },
  ],
  ["invalid image reference", { versions: [version(12, ["ubuntu:latest"]), ...versions.slice(1)] }],
  ["zero retained versions", { retain: 0 }],
] satisfies [string, object][]) {
  await test(`blocks with an empty deletion list on ${name}`, () => {
    const plan = selectTags({ ...input, ...overrides });
    assert.equal(plan.kind, "blocked");
    assert.deepEqual(plan.remove, []);
  });
}

await test("keeps every version when the history is shorter than ten", () => {
  const plan = selectTags({ ...input, versions: [version(12)], tags: [tag(12), tag(1)] });
  assert.equal(plan.kind, "ready");
  assert.deepEqual(plan.remove, []);
});

function fixture() {
  const calls: string[][] = [];
  const logs: string[] = [];
  const summaries = versions.map((v, i) => ({
    id: v.id,
    number: 12 - i,
    metadata: { created_on: v.createdOn },
  }));
  const deployment = {
    success: true,
    result: { deployments: [{ id: id(50), versions: [{ version_id: id(12) }] }] },
  };
  function json(path: string): unknown {
    if (path === "/deployments") return deployment;
    if (path.startsWith("/versions?")) {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      const items = summaries.slice((page - 1) * 10, page * 10);
      return {
        success: true,
        result: { items },
        result_info: { page, per_page: 10, count: items.length, total_count: 12 },
      };
    }
    const v = versions.find((v) => path === `/versions/${v.id}`);
    assert(v, `unexpected REST path ${path}`);
    return {
      success: true,
      result: {
        id: v.id,
        resources: { script_runtime: { containers: [{ images: { geometry: v.imageRefs[0] } }] } },
      },
    };
  }
  function command(args: string[]) {
    calls.push(args);
    assert.deepEqual(args.slice(0, 3), ["containers", "registries", "credentials"]);
    return JSON.stringify({
      account_id: account,
      registry_host: "registry.cloudflare.com",
      username: "test",
      password: "test-password",
    });
  }
  const names = [digest(1), "tag-12", "tag-3", "tag-2", "tag-1"];
  const mutations: string[] = [];
  const registry = {
    catalog: (): Promise<{ hasLink: boolean; body: { repositories: Record<string, string[]> } }> =>
      Promise.resolve({
        hasLink: false,
        body: {
          repositories: {
            [`${account}/${repository}`]: names,
            [`${account}/${other}`]: ["foreign"],
          },
        },
      }),
    manifest: (
      repo: string,
      name: string,
    ): Promise<{ digest: string | null; body: Uint8Array<ArrayBuffer> }> => {
      assert.equal(repo, repository);
      const n = name === digest(1) ? 1 : Number(name.split("-")[1]);
      return Promise.resolve({ digest: digest(n), body: body(n) });
    },
    delete(repo: string, name: string): Promise<"deleted" | "missing"> {
      assert.equal(repo, repository);
      mutations.push(name);
      return Promise.resolve(name === digest(1) ? "missing" : "deleted");
    },
    gc() {
      mutations.push("gc");
      return Promise.resolve();
    },
  };
  return {
    apply: false,
    json: (path: string) => Promise.resolve(json(path)),
    command: (args: string[]) => Promise.resolve(command(args)),
    registry: () => registry,
    mutations,
    log: (s: string) => logs.push(s),
    calls,
    logs,
  };
}

await test("reads every version page and detail", async () => {
  assert.deepEqual(await collectVersions(fixture().json), versions);
});

await test("dry-run reports candidates without deleting or reading other repositories' manifests", async () => {
  const f = fixture();
  const result = await runRetention(f);
  assert.deepEqual(result.keep, [tag(12), tag(3)]);
  assert.deepEqual(result.remove, [tag(1, digest(1)), tag(2), tag(1)]);
  assert(!f.calls.flat().includes("--push"));
  assert.deepEqual(f.mutations, []);
  assert(f.logs.some((s) => s.includes('"mode":"dry-run"')));
  if (process.env.GITHUB_ACTIONS === "true") {
    assert(f.logs.includes("::add-mask::test-password"));
  }
  assert(
    !f.logs.filter((s) => !s.startsWith("::add-mask::")).some((s) => s.includes("test-password")),
  );
});

await test("apply deletes named tags before digest entries and collects layers once", async () => {
  const f = fixture();
  await runRetention({ ...f, apply: true });
  assert.deepEqual(f.mutations, ["tag-2", "tag-1", digest(1), "gc"]);
  assert(f.calls.flat().includes("--push"));
  assert(f.logs.some((s) => s.includes(`"deleted":"${tag(1).tag}"`)));
  assert(f.logs.some((s) => s.includes(`"missing":"${tag(1, digest(1)).tag}"`)));
});

await test("a missing named tag stops deletion", async () => {
  const f = fixture();
  f.registry().delete = (_repo, name) => {
    f.mutations.push(name);
    return Promise.resolve("missing");
  };
  await assert.rejects(runRetention({ ...f, apply: true }), /Named tag missing/u);
  assert.deepEqual(f.mutations, ["tag-2"]);
});

await test("garbage collection failure is reported as a warning", async () => {
  const f = fixture();
  f.registry().gc = () => Promise.reject(new Error("unavailable"));
  await runRetention({ ...f, apply: true });
  assert(f.logs.some((s) => s.includes("Warning") && s.includes("garbage collection")));
});

await test("manifest annotation protects the runtime artifact of a retained image", async () => {
  const f = fixture();
  const artifact = new TextEncoder().encode(
    JSON.stringify({ annotations: { "io.cloudflare.cloudchamber.image_digest": digest(12) } }),
  );
  const name = hash(artifact);
  const catalog = await f.registry().catalog();
  catalog.body.repositories[`${account}/${repository}`]?.push(name);
  const manifest = f.registry().manifest;
  f.registry().manifest = (repo, ref) =>
    ref === name ? Promise.resolve({ digest: name, body: artifact }) : manifest(repo, ref);
  const plan = await runRetention(f);
  assert(plan.keep.some((entry) => entry.digest === name && entry.preparedFrom === digest(12)));
});

await test("a catalog missing the target repository blocks deletion", async () => {
  const f = fixture();
  f.registry().catalog = () => Promise.resolve({ hasLink: false, body: { repositories: {} } });
  await assert.rejects(runRetention({ ...f, apply: true }), /Target repository/u);
  assert.deepEqual(f.mutations, []);
});

await test("a paginated catalog blocks all deletion", async () => {
  const f = fixture();
  const catalog = await f.registry().catalog();
  f.registry().catalog = () => Promise.resolve({ ...catalog, hasLink: true });
  await assert.rejects(runRetention({ ...f, apply: true }), /Paginated/u);
  assert.deepEqual(f.mutations, []);
});

for (const problem of [
  "GET failed",
  "missing header",
  "wrong hash",
  "invalid JSON",
  "invalid annotation",
]) {
  await test(`manifest with ${problem} blocks all deletion`, async () => {
    const f = fixture();
    const manifest = f.registry().manifest;
    f.registry().manifest = async (repo, name) => {
      const valid = await manifest(repo, name);
      if (name !== "tag-1") return valid;
      if (problem === "GET failed") throw new Error("unavailable");
      if (problem === "missing header") return { ...valid, digest: null };
      if (problem === "wrong hash") return { ...valid, digest: digest(2) };
      const body = new TextEncoder().encode(
        problem === "invalid JSON"
          ? "{"
          : '{"annotations":{"io.cloudflare.cloudchamber.image_digest":"invalid"}}',
      );
      return { digest: hash(body), body };
    };
    await assert.rejects(runRetention({ ...f, apply: true }));
    assert.deepEqual(f.mutations, []);
  });
}
for (const name of [
  "missing metadata",
  "repeated page",
  "changing total",
  "missing item",
  "unreadable detail",
  "deployment changed",
  "new version",
]) {
  await test(`collection fails before deleting on ${name}`, async () => {
    const f = fixture();
    let pageOneReads = 0;
    let deploymentReads = 0;
    const json = async (path: string) => {
      const original = await f.json(path);
      if (path === "/deployments" && ++deploymentReads > 1 && name === "deployment changed") {
        return {
          success: true,
          result: { deployments: [{ id: id(51), versions: [{ version_id: id(12) }] }] },
        };
      }
      if (name === "unreadable detail" && path === `/versions/${id(1)}`)
        throw new Error("detail unavailable");
      if (path.includes("page=1&")) {
        pageOneReads++;
        if (name === "missing metadata") return { success: true, result: { items: [] } };
        if (name === "new version" && pageOneReads > 1)
          return f.json("/versions?page=2&per_page=10");
      }
      if (!path.includes("page=2&")) return original;
      if (name === "repeated page") return f.json("/versions?page=1&per_page=10");
      if (name === "changing total")
        return {
          success: true,
          result: { items: [] },
          result_info: { page: 2, per_page: 10, count: 0, total_count: 13 },
        };
      if (name === "missing item")
        return {
          success: true,
          result: { items: [] },
          result_info: { page: 2, per_page: 10, count: 0, total_count: 12 },
        };
      return original;
    };
    await assert.rejects(runRetention({ ...f, apply: true, json }));
    assert.deepEqual(f.mutations, []);
  });
}

await test("malformed credential JSON never appears in an exception", async () => {
  const f = fixture();
  await assert.rejects(
    runRetention({
      ...f,
      apply: true,
      command: (args) =>
        args[1] === "registries"
          ? Promise.resolve('{"password":"test-password" broken')
          : f.command(args),
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "Invalid Wrangler JSON; output withheld");
      return true;
    },
  );
  assert.deepEqual(f.mutations, []);
});

await test("multiple retained repositories stop collection before any registry mutation", async () => {
  const f = fixture();
  await assert.rejects(
    runRetention({
      ...f,
      apply: true,
      json: (path) =>
        path === `/versions/${id(12)}`
          ? Promise.resolve({
              success: true,
              result: {
                id: id(12),
                resources: {
                  script_runtime: {
                    containers: [{ images: { geometry: ref(12), another: ref(1, other) } }],
                  },
                },
              },
            })
          : f.json(path),
    }),
    /exactly one repository/u,
  );
  assert.deepEqual(f.mutations, []);
});
