import { displayContentType } from "@madori/contracts";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import {
  createProject,
  listProjects,
  listPatterns,
  readPatternState,
  fetchRevisionView,
  ApiError,
} from "./api.ts";
void test("API failures carry codes, retry hints and no transport messages", async () => {
  const responses = [
    new Response("<html>proxy failure</html>", { status: 502 }),
    Response.json(
      { error: "service_unavailable" },
      { status: 503, headers: { "retry-after": "5" } },
    ),
    new Response("oops", { headers: { "x-revision-id": "R" } }),
    new Response("bytes", {
      headers: { "content-type": displayContentType, "x-revision-id": "other" },
    }),
  ];
  const mocked = mock.method(globalThis, "fetch", () =>
    Promise.resolve(responses.shift() ?? new Response()),
  );
  try {
    for (const [code, retryAfter] of [
      ["unexpected_response", undefined],
      ["service_unavailable", 5],
      ["unexpected_response", undefined],
      ["unexpected_response", undefined],
    ] as const)
      await assert.rejects(
        fetchRevisionView("R", new AbortController().signal),
        (error: unknown) =>
          error instanceof ApiError && error.code === code && error.retryAfter === retryAfter,
      );
    mocked.mock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    await assert.rejects(
      fetchRevisionView("R", new AbortController().signal),
      (error: unknown) => error instanceof ApiError && error.code === "network",
    );
  } finally {
    mocked.mock.restore();
  }
});

void test("public contracts expose the display media type", async () => {
  const contract = await import("@madori/contracts");
  assert.equal(
    Reflect.get(contract, "displayContentType"),
    "application/vnd.madori.display; version=1",
  );
});

void test("JSON endpoints reject off-contract and malformed responses", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({})));
  const signal = new AbortController().signal;
  const requestId = crypto.randomUUID();
  const unexpected = (error: unknown) =>
    error instanceof ApiError && error.code === "unexpected_response";
  await assert.rejects(createProject({ requestId }, signal), unexpected);
  await assert.rejects(listProjects(null, signal), unexpected);
  await assert.rejects(listPatterns("P", signal), unexpected);
  await assert.rejects(readPatternState("P", signal), unexpected);
  mocked.mock.mockImplementation(() => Promise.resolve(new Response("bad json")));
  await assert.rejects(readPatternState("P", signal), unexpected);
  mocked.mock.mockImplementation(() =>
    Promise.resolve(Response.json({ error: "request_id_reused" }, { status: 422 })),
  );
  await assert.rejects(createProject({ requestId }, signal), new ApiError("request_id_reused"));
});
