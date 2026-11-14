import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { fetchSampleDisplay, ApiError } from "./api.ts";
void test("API failures carry codes, retry hints and no transport messages", async () => {
  const responses = [
    new Response("<html>proxy failure</html>", { status: 502 }),
    Response.json(
      { error: "service_unavailable" },
      { status: 503, headers: { "retry-after": "5" } },
    ),
    new Response("oops"),
  ];
  const mocked = mock.method(globalThis, "fetch", () =>
    Promise.resolve(responses.shift() ?? new Response()),
  );
  try {
    for (const [code, retryAfter] of [
      ["unexpected_response", undefined],
      ["service_unavailable", 5],
      ["unexpected_response", undefined],
    ] as const)
      await assert.rejects(
        fetchSampleDisplay(new AbortController().signal),
        (error: unknown) =>
          error instanceof ApiError && error.code === code && error.retryAfter === retryAfter,
      );
    mocked.mock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    await assert.rejects(
      fetchSampleDisplay(new AbortController().signal),
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
