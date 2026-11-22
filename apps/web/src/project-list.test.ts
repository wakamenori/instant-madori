import assert from "node:assert/strict";
import { test } from "node:test";
import { listProjects } from "./api.ts";
import {
  beginCreate,
  finishCreate,
  reduceProjectList,
  initialProjectList,
  cursorToLoad,
} from "./project-list.ts";

void test("loading more uses the opaque cursor and appends only the requested page", async (t) => {
  const createdAt = "2026-11-22T00:00:00Z";
  const a = { id: crypto.randomUUID(), name: "A", version: 1, createdAt, updatedAt: createdAt };
  const b = { ...a, id: crypto.randomUUID(), name: "B" };
  const cursor = "abc/+==";
  const pages = [
    { projects: [a], nextCursor: cursor },
    { projects: [b], nextCursor: null },
  ];
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", (path: string) => {
    paths.push(path);
    return Promise.resolve(Response.json(pages.shift()));
  });
  const signal = new AbortController().signal;
  const first = reduceProjectList(initialProjectList, {
    kind: "first_page",
    page: await listProjects(null, signal),
  });
  const loading = reduceProjectList(first, { kind: "more_requested" });
  assert.deepEqual(reduceProjectList(loading, { kind: "more_requested" }), loading);
  const failed = reduceProjectList(loading, {
    kind: "next_page_failed",
    cursor,
    message: "通信エラー",
  });
  assert.deepEqual(failed, {
    kind: "loaded",
    projects: [a],
    more: { kind: "failed", cursor, message: "通信エラー" },
  });
  const retry = reduceProjectList(failed, { kind: "more_requested" });
  const page = await listProjects(cursorToLoad(retry), signal);
  assert.deepEqual(paths, ["/api/projects", "/api/projects?cursor=abc%2F%2B%3D%3D"]);
  assert.deepEqual(reduceProjectList(retry, { kind: "next_page", cursor: "old", page }), retry);
  const end = reduceProjectList(retry, { kind: "next_page", cursor, page });
  assert.deepEqual(end, { kind: "loaded", projects: [a, b], more: { kind: "end" } });
  assert.deepEqual(reduceProjectList(end, { kind: "next_page", cursor, page }), end);
});

void test("a retry keeps the request ID and a second press while sending is ignored", () => {
  const first = beginCreate({ kind: "idle" });
  assert.ok(first);
  assert.equal(beginCreate(first), null);
  assert.deepEqual(beginCreate(finishCreate(first, "通信エラー")), first);
  const success = finishCreate(first, null);
  assert.deepEqual(success, { kind: "idle" });
  assert.notEqual(beginCreate(success)?.requestId, first.requestId);
});
