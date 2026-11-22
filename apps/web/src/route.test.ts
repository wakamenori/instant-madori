import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute, formatRoute } from "./route.ts";

void test("a project URL round trips with a lowercase UUID", () => {
  const id = "af126f16-e0f8-4d98-be40-ffc6b483bc67";
  const route = parseRoute(`/projects/${id.toUpperCase()}`);
  assert.equal(route.kind, "project");
  assert.equal(formatRoute(route), `/projects/${id}`);
  assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.deepEqual(parseRoute("/"), { kind: "projects" });
  for (const path of [
    "/projects",
    "/projects/xyz",
    `/projects/${id}/`,
    `/projects/${id}/edit`,
    "/missing",
  ])
    assert.deepEqual(parseRoute(path), { kind: "not_found" });
});
