import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiErrorSchema,
  createProjectResponseSchema,
  patternListResponseSchema,
  patternResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
} from "@madori/contracts";
import type { CreateProjectResponse, Project } from "@madori/contracts";
import type { AccessUser } from "../../../scripts/dev/local-access.ts";
import { newUser, startLocalWorker } from "./support/local-worker.ts";
import type { LocalWorker } from "./support/local-worker.ts";

/**
 * The documented list order: newest `createdAt` first, ties broken by descending ID.
 * Projects created in the same millisecond tie, so creation order alone is not the order.
 */
function listOrder(projects: Project[]): string[] {
  // Plain code-unit comparison, like SQLite's default BINARY collation.
  const descending = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
  return [...projects]
    .sort((a, b) => descending(a.createdAt, b.createdAt) || descending(a.id, b.id))
    .map(({ id }) => id);
}

/** Builds a cursor the way the API encodes one (base64url of `[createdAt, id]`). */
function cursorOf(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

async function errorCode(response: Response) {
  return apiErrorSchema.parse(await response.json()).error;
}

async function createProject(worker: LocalWorker, as: AccessUser, name?: string) {
  const response = await worker.call("/api/projects", {
    method: "POST",
    as,
    body: { requestId: crypto.randomUUID(), ...(name === undefined ? {} : { name }) },
  });
  assert.equal(response.status, 201);
  return createProjectResponseSchema.parse(await response.json());
}

async function listAllProjects(worker: LocalWorker, as: AccessUser) {
  const response = await worker.call("/api/projects", { as });
  assert.equal(response.status, 200);
  return projectListResponseSchema.parse(await response.json());
}

await test("Projects and patterns", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());

  await t.test("creating a project starts its first pattern with default names", async () => {
    const owner = newUser("create");
    const created = await createProject(worker, owner);
    assert.equal(created.project.name, "新しい案件");
    assert.equal(created.project.version, 1);
    assert.equal(created.pattern.projectId, created.project.id);
    assert.equal(created.pattern.name, "パターン1");
    const named = await createProject(worker, owner, "  山田様邸  ");
    assert.equal(named.project.name, "山田様邸", "names are trimmed");
    const list = await listAllProjects(worker, owner);
    assert.deepEqual(
      list.projects.map(({ id }) => id),
      listOrder([named.project, created.project]),
      "newest first",
    );
  });

  await t.test("reading a project by ID returns its list row", async () => {
    const owner = newUser("read");
    const { project } = await createProject(worker, owner, "山田様邸");
    await createProject(worker, owner, "佐藤様邸");
    const list = await listAllProjects(worker, owner);
    const response = await worker.call(`/api/projects/${project.id}`, { as: owner });
    assert.equal(response.status, 200);
    const read = projectResponseSchema.parse(await response.json());
    assert.deepEqual(
      read.project,
      list.projects.find(({ id }) => id === project.id),
    );
  });

  await t.test(
    "patterns are numbered without gaps or duplicates and listed in that order",
    async () => {
      const owner = newUser("numbering");
      const { project } = await createProject(worker, owner);
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          worker.call(`/api/projects/${project.id}/patterns`, {
            method: "POST",
            as: owner,
            body: { requestId: crypto.randomUUID() },
          }),
        ),
      );
      for (const response of responses) assert.equal(response.status, 201);
      const list = patternListResponseSchema.parse(
        await (await worker.call(`/api/projects/${project.id}/patterns`, { as: owner })).json(),
      );
      // Not sorted here: the list itself must come back in number order, even though
      // patterns created concurrently can share a timestamp.
      assert.deepEqual(
        list.patterns.map(({ name }) => name),
        ["パターン1", "パターン2", "パターン3", "パターン4", "パターン5", "パターン6"],
      );
    },
  );

  await t.test("another user's project and patterns look missing", async () => {
    const owner = newUser("owner");
    const stranger = newUser("stranger");
    const { project, pattern } = await createProject(worker, owner);
    const attempts = [
      worker.call(`/api/projects/${project.id}`, { as: stranger }),
      worker.call(`/api/projects/${crypto.randomUUID()}`, { as: stranger }),
      worker.call(`/api/projects/${project.id}/patterns`, { as: stranger }),
      worker.call(`/api/projects/${project.id}/patterns`, {
        method: "POST",
        as: stranger,
        body: { requestId: crypto.randomUUID() },
      }),
      worker.call(`/api/projects/${project.id}`, {
        method: "PATCH",
        as: stranger,
        body: { requestId: crypto.randomUUID(), version: 1, name: "乗っ取り" },
      }),
      worker.call(`/api/patterns/${pattern.id}`, {
        method: "PATCH",
        as: stranger,
        body: { requestId: crypto.randomUUID(), version: 1, name: "乗っ取り" },
      }),
    ];
    for (const response of await Promise.all(attempts)) {
      assert.equal(response.status, 404);
      assert.equal(await errorCode(response), "not_found");
    }
    assert.deepEqual((await listAllProjects(worker, stranger)).projects, []);
    const unchanged = await listAllProjects(worker, owner);
    assert.equal(unchanged.projects[0]?.name, "新しい案件");
    // The stranger's rejected attempt must not have consumed a pattern number either.
    const next = await worker.call(`/api/projects/${project.id}/patterns`, {
      method: "POST",
      as: owner,
      body: { requestId: crypto.randomUUID() },
    });
    assert.equal(patternResponseSchema.parse(await next.json()).pattern.name, "パターン2");
  });

  await t.test("renames require the current version and bump it", async () => {
    const owner = newUser("rename");
    const { project, pattern } = await createProject(worker, owner);
    const renamed = await worker.call(`/api/projects/${project.id}`, {
      method: "PATCH",
      as: owner,
      body: { requestId: crypto.randomUUID(), version: 1, name: "佐藤様邸" },
    });
    assert.equal(renamed.status, 200);
    const { project: after } = projectResponseSchema.parse(await renamed.json());
    assert.equal(after.name, "佐藤様邸");
    assert.equal(after.version, 2);
    assert.equal(after.createdAt, project.createdAt);
    // The response is the stored request result, built before the update ran; it must
    // equal the row the update actually left.
    assert.deepEqual((await listAllProjects(worker, owner)).projects, [after]);

    const read = await worker.call(`/api/projects/${project.id}`, { as: owner });
    assert.equal(read.status, 200);
    assert.deepEqual(projectResponseSchema.parse(await read.json()).project, after);

    const stale = await worker.call(`/api/projects/${project.id}`, {
      method: "PATCH",
      as: owner,
      body: { requestId: crypto.randomUUID(), version: 1, name: "古い画面から" },
    });
    assert.equal(stale.status, 409);
    assert.equal(await errorCode(stale), "version_conflict");

    const patternRenamed = await worker.call(`/api/patterns/${pattern.id}`, {
      method: "PATCH",
      as: owner,
      body: { requestId: crypto.randomUUID(), version: 1, name: "南道路の案" },
    });
    assert.equal(patternRenamed.status, 200);
    const { pattern: patternAfter } = patternResponseSchema.parse(await patternRenamed.json());
    assert.deepEqual(
      [patternAfter.name, patternAfter.version, patternAfter.projectId],
      ["南道路の案", 2, project.id],
    );
    const stored = patternListResponseSchema.parse(
      await (await worker.call(`/api/projects/${project.id}/patterns`, { as: owner })).json(),
    );
    assert.deepEqual(stored.patterns, [patternAfter]);
  });

  await t.test("a resent request returns the first result and changes nothing more", async () => {
    const owner = newUser("resend");
    const body = { requestId: crypto.randomUUID(), name: "再送テスト" };
    const send = () => worker.call("/api/projects", { method: "POST", as: owner, body });
    const first = await send();
    const firstText = await first.text();
    const second = await send();
    assert.equal(second.status, 201);
    assert.equal(await second.text(), firstText);
    assert.equal((await listAllProjects(worker, owner)).projects.length, 1);

    const { project } = createProjectResponseSchema.parse(JSON.parse(firstText));
    const rename = { requestId: crypto.randomUUID(), version: 1, name: "改名" };
    const renameOnce = () =>
      worker.call(`/api/projects/${project.id}`, { method: "PATCH", as: owner, body: rename });
    const renamedText = await (await renameOnce()).text();
    // The version is now 2, so applying the rename again would conflict; a replay must not.
    const replay = await renameOnce();
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), renamedText);
    // The replay is the stored bytes either way; only the row shows whether it re-applied.
    assert.deepEqual((await listAllProjects(worker, owner)).projects, [
      projectResponseSchema.parse(JSON.parse(renamedText)).project,
    ]);
  });

  await t.test("a request ID is the same request in any letter case", async () => {
    const owner = newUser("case");
    const requestId = crypto.randomUUID();
    const send = (id: string) =>
      worker.call("/api/projects", { method: "POST", as: owner, body: { requestId: id } });
    const first = await (await send(requestId)).text();
    const upper = await send(requestId.toUpperCase());
    assert.equal(upper.status, 201);
    assert.equal(await upper.text(), first);
    assert.equal((await listAllProjects(worker, owner)).projects.length, 1);
  });

  await t.test("concurrent resends of one request apply it exactly once", async () => {
    const owner = newUser("concurrent");
    const body = { requestId: crypto.randomUUID() };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        worker.call("/api/projects", { method: "POST", as: owner, body }),
      ),
    );
    const texts = await Promise.all(responses.map((response) => response.text()));
    for (const response of responses) assert.equal(response.status, 201);
    assert.equal(new Set(texts).size, 1);
    assert.equal((await listAllProjects(worker, owner)).projects.length, 1);

    const { project } = createProjectResponseSchema.parse(JSON.parse(texts[0] ?? ""));
    const rename = { requestId: crypto.randomUUID(), version: 1, name: "同時改名" };
    const renames = await Promise.all(
      Array.from({ length: 6 }, () =>
        worker.call(`/api/projects/${project.id}`, { method: "PATCH", as: owner, body: rename }),
      ),
    );
    const renameTexts = await Promise.all(renames.map((response) => response.text()));
    for (const response of renames) assert.equal(response.status, 200);
    assert.equal(new Set(renameTexts).size, 1);
    const renamed = projectResponseSchema.parse(JSON.parse(renameTexts[0] ?? "")).project;
    assert.equal(renamed.version, 2);
    assert.deepEqual((await listAllProjects(worker, owner)).projects, [renamed], "applied once");
  });

  await t.test("resent pattern requests apply once and consume no extra number", async () => {
    const owner = newUser("pattern-resend");
    const { project, pattern: first } = await createProject(worker, owner);
    const create = { requestId: crypto.randomUUID() };
    const createOnce = () =>
      worker.call(`/api/projects/${project.id}/patterns`, {
        method: "POST",
        as: owner,
        body: create,
      });
    const created = await Promise.all(Array.from({ length: 4 }, createOnce));
    const createdTexts = await Promise.all(created.map((response) => response.text()));
    for (const response of created) assert.equal(response.status, 201);
    assert.equal(new Set(createdTexts).size, 1, "every resend returns the first result");
    const replayed = await createOnce();
    assert.equal(replayed.status, 201);
    assert.equal(await replayed.text(), createdTexts[0]);
    const { pattern: second } = patternResponseSchema.parse(JSON.parse(createdTexts[0] ?? ""));
    assert.equal(second.name, "パターン2");

    const rename = { requestId: crypto.randomUUID(), version: 1, name: "北側の案" };
    const renameOnce = () =>
      worker.call(`/api/patterns/${first.id}`, { method: "PATCH", as: owner, body: rename });
    const renamed = await Promise.all(Array.from({ length: 4 }, renameOnce));
    const renamedTexts = await Promise.all(renamed.map((response) => response.text()));
    for (const response of renamed) assert.equal(response.status, 200);
    assert.equal(new Set(renamedTexts).size, 1);
    // Version 1 is gone now; a replay must still return the stored result, not a conflict.
    const replayedRename = await renameOnce();
    assert.equal(replayedRename.status, 200);
    assert.equal(await replayedRename.text(), renamedTexts[0]);

    const third = await worker.call(`/api/projects/${project.id}/patterns`, {
      method: "POST",
      as: owner,
      body: { requestId: crypto.randomUUID() },
    });
    const list = patternListResponseSchema.parse(
      await (await worker.call(`/api/projects/${project.id}/patterns`, { as: owner })).json(),
    );
    assert.equal(patternResponseSchema.parse(await third.json()).pattern.name, "パターン3");
    assert.deepEqual(
      list.patterns.map(({ name, version }) => [name, version]),
      [
        ["北側の案", 2],
        ["パターン2", 1],
        ["パターン3", 1],
      ],
    );
  });

  await t.test("a request ID cannot be reused for a different change", async () => {
    const owner = newUser("reuse");
    const requestId = crypto.randomUUID();
    const first = await worker.call("/api/projects", {
      method: "POST",
      as: owner,
      body: { requestId, name: "最初" },
    });
    assert.equal(first.status, 201);
    const { project } = createProjectResponseSchema.parse(await first.json());
    const reused = await Promise.all([
      worker.call("/api/projects", { method: "POST", as: owner, body: { requestId, name: "別" } }),
      worker.call(`/api/projects/${project.id}`, {
        method: "PATCH",
        as: owner,
        body: { requestId, version: 1, name: "別" },
      }),
    ]);
    for (const response of reused) {
      assert.equal(response.status, 422);
      assert.equal(await errorCode(response), "request_id_reused");
    }
    // Request IDs are scoped to the user, so another user may use the same value.
    const other = await worker.call("/api/projects", {
      method: "POST",
      as: newUser("other"),
      body: { requestId, name: "最初" },
    });
    assert.equal(other.status, 201);
  });

  await t.test("a failed request leaves its ID free for a corrected retry", async () => {
    const owner = newUser("retry");
    const { project } = await createProject(worker, owner);
    const requestId = crypto.randomUUID();
    const stale = await worker.call(`/api/projects/${project.id}`, {
      method: "PATCH",
      as: owner,
      body: { requestId, version: 7, name: "再試行" },
    });
    assert.equal(stale.status, 409);
    // The 409 was not recorded, so the same ID with a corrected body is a new attempt.
    const corrected = await worker.call(`/api/projects/${project.id}`, {
      method: "PATCH",
      as: owner,
      body: { requestId, version: 1, name: "再試行" },
    });
    assert.equal(corrected.status, 200);
    const correctedText = await corrected.text();
    // From now on the ID is bound to the corrected request.
    const replay = await worker.call(`/api/projects/${project.id}`, {
      method: "PATCH",
      as: owner,
      body: { requestId, version: 1, name: "再試行" },
    });
    assert.equal(await replay.text(), correctedText);
    const reusedForOldBody = await worker.call(`/api/projects/${project.id}`, {
      method: "PATCH",
      as: owner,
      body: { requestId, version: 7, name: "再試行" },
    });
    assert.equal(reusedForOldBody.status, 422);
  });

  await t.test("the project list pages through every project exactly once", async () => {
    const owner = newUser("paging");
    const created: CreateProjectResponse[] = [];
    for (let index = 0; index < 53; index += 1) {
      created.push(await createProject(worker, owner, `案件${index}`));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string =
        cursor === null ? "/api/projects" : `/api/projects?cursor=${encodeURIComponent(cursor)}`;
      const page = projectListResponseSchema.parse(
        await (await worker.call(path, { as: owner })).json(),
      );
      seen.push(...page.projects.map(({ id }) => id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    assert.equal(pages, 2);
    assert.equal(new Set(seen).size, seen.length, "no project twice");
    assert.deepEqual(seen, listOrder(created.map(({ project }) => project)));
  });

  await t.test("names are limited to 100 characters, counted as characters", async () => {
    const owner = newUser("length");
    const create = (name: string) =>
      worker.call("/api/projects", {
        method: "POST",
        as: owner,
        body: { requestId: crypto.randomUUID(), name },
      });
    // 60 emoji are 60 characters but 120 UTF-16 code units.
    assert.equal((await create("🏠".repeat(60))).status, 201);
    assert.equal((await create("間".repeat(100))).status, 201);
    assert.equal((await create("間".repeat(101))).status, 400);
    assert.equal((await create("\u200b\u2060")).status, 400, "only invisible characters");
    assert.equal((await create("案件\ud800")).status, 400, "lone surrogate");
  });

  await t.test("malformed input is rejected before reaching storage", async () => {
    const owner = newUser("invalid");
    const { project } = await createProject(worker, owner);
    const cases: [string, Parameters<LocalWorker["call"]>[1], number][] = [
      ["/api/projects", { method: "POST", as: owner, body: {} }, 400],
      ["/api/projects", { method: "POST", as: owner, body: { requestId: "not-a-uuid" } }, 400],
      [
        "/api/projects",
        { method: "POST", as: owner, body: { requestId: crypto.randomUUID(), name: "   " } },
        400,
      ],
      [
        "/api/projects",
        { method: "POST", as: owner, body: { requestId: crypto.randomUUID(), extra: true } },
        400,
      ],
      [
        "/api/projects",
        {
          method: "POST",
          as: owner,
          body: { requestId: crypto.randomUUID() },
          headers: { "content-type": "text/plain" },
        },
        400,
      ],
      [
        "/api/projects",
        {
          method: "POST",
          as: owner,
          body: { requestId: crypto.randomUUID(), name: "x".repeat(20_000) },
        },
        413,
      ],
      [
        "/api/projects",
        { method: "POST", as: owner, body: { requestId: crypto.randomUUID(), name: "\u0000案件" } },
        400,
      ],
      ["/api/projects?cursor=garbage", { as: owner }, 400],
      // Valid-looking but not in the stored form, which would misplace the page boundary.
      [`/api/projects?cursor=${cursorOf("2026-11-13T00:00:00Z", project.id)}`, { as: owner }, 400],
      [
        `/api/projects?cursor=${cursorOf("2026-11-13T00:00:00.000Z", project.id.toUpperCase())}`,
        { as: owner },
        400,
      ],
      [
        `/api/projects?cursor=${cursorOf("2026-11-13T00:00:00.000Z", project.id)}`,
        { as: owner },
        200,
      ],
      ["/api/projects?__proto__=x", { as: owner }, 400],
      ["/api/projects?constructor=x", { as: owner }, 400],
      ["/api/projects?cursor=a&cursor=b", { as: owner }, 400],
      [`/api/projects/${project.id}`, { method: "PATCH", as: owner, body: { version: 1 } }, 400],
      ["/api/projects/not-a-uuid/patterns", { as: owner }, 404],
    ];
    for (const [path, options, expected] of cases) {
      const response = await worker.call(path, options);
      assert.equal(response.status, expected, `${options?.method ?? "GET"} ${path}`);
    }
  });
});
