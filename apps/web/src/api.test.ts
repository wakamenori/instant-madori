import { readFileSync } from "node:fs";
import { displayContentType } from "@madori/contracts";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import {
  createProject,
  listProjects,
  listPatterns,
  readPatternState,
  fetchRevisionView,
  fetchFloorPlan,
  ApiError,
} from "./api.ts";
void test("API failures carry codes and no transport messages", async () => {
  const responses = [
    new Response("<html>proxy failure</html>", { status: 502 }),
    Response.json({ error: "unknown_code" }, { status: 503 }),
    new Response("oops", { headers: { "x-revision-id": "R", "x-floor-plan-storeys": "" } }),
    new Response("bytes", {
      headers: {
        "content-type": displayContentType,
        "x-revision-id": "other",
        "x-floor-plan-storeys": "",
      },
    }),
  ];
  const mocked = mock.method(globalThis, "fetch", () => Promise.resolve(new Response()));
  try {
    for (const response of responses) {
      mocked.mock.mockImplementationOnce(() => Promise.resolve(response));
      await assert.rejects(
        fetchRevisionView("R", new AbortController().signal),
        (error: unknown) => error instanceof ApiError && error.code === "unexpected_response",
      );
    }
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

void test("revision views require an ordered list of distinct storeys", async (t) => {
  const signal = new AbortController().signal;
  const bytes = new Uint8Array([0, 255]);
  const mockFetch = t.mock.method(globalThis, "fetch");
  const fetchView = (header: string | null) => {
    const headers = new Headers({ "content-type": displayContentType, "x-revision-id": "R" });
    if (header !== null) headers.set("x-floor-plan-storeys", header);
    mockFetch.mock.mockImplementationOnce(() => Promise.resolve(new Response(bytes, { headers })));
    return fetchRevisionView("R", signal);
  };
  assert.deepEqual(await fetchView("s1,s2"), { display: bytes, storeys: ["s1", "s2"] });
  assert.deepEqual(await fetchView(""), { display: bytes, storeys: [] });
  for (const header of [null, "a,,b", "a,a", "a b"]) {
    await assert.rejects(fetchView(header), new ApiError("unexpected_response"));
  }
});

void test("floor plans request an encoded storey and require a matching revision and SVG type", async (t) => {
  const svg = readFileSync(new URL("./floor-plan/verification-1.svg", import.meta.url), "utf8");
  let body = svg;
  const mockFetch = t.mock.method(globalThis, "fetch", (path: string) => {
    assert.equal(path, "/api/revisions/R/floor-plan?storey=a5e84c0db7%3As1");
    return Promise.resolve(
      new Response(body, {
        headers: { "content-type": "image/svg+xml", "x-revision-id": "R" },
      }),
    );
  });
  const fetchPlan = () => fetchFloorPlan("R", "a5e84c0db7:s1", new AbortController().signal);
  assert.equal((await fetchPlan())?.selectable.size, 9);
  body = svg.replace("</svg>", "<script/></svg>");
  assert.equal(await fetchPlan(), null);
  for (const headers of [
    { "content-type": "image/svg+xml", "x-revision-id": "other" },
    { "content-type": "text/html", "x-revision-id": "R" },
  ]) {
    mockFetch.mock.mockImplementationOnce(() => Promise.resolve(new Response(svg, { headers })));
    await assert.rejects(fetchPlan(), new ApiError("unexpected_response"));
  }
  mockFetch.mock.mockImplementationOnce(() =>
    Promise.resolve(Response.json({ error: "not_found" }, { status: 404 })),
  );
  await assert.rejects(fetchPlan(), new ApiError("not_found"));
});
