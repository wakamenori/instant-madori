import assert from "node:assert/strict";
import { test } from "node:test";
import { workersLogs, formatLogRows, parseLogRows } from "./workers-logs.ts";
const timeframe = { from: 1, to: 5 };
const event = { timestamp: 3, source: "one", $metadata: { service: "staging" } };
const envelope = (events: unknown[]) => ({ success: true, result: { events: { events } } });
const query = (body: unknown) =>
  workersLogs("test", () => Promise.resolve(Response.json(body)))(timeframe);

await test("rejects malformed Workers Logs envelopes and fields", async () => {
  for (const body of [
    { success: true, result: { events: {} } },
    envelope([{ ...event, timestamp: "3" }]),
    envelope([{ ...event, $metadata: {} }]),
  ]) {
    await assert.rejects(query(body), /Invalid Workers Logs response/u);
  }
});
await test("rejects API failures without exposing error bodies", async () => {
  await assert.rejects(
    query({ success: false, errors: [{ code: 42, message: "sensitive details" }] }),
    { message: "Workers Logs query was unsuccessful (codes 42)" },
  );
  await assert.rejects(
    workersLogs("test", () => Promise.resolve(new Response("sensitive details", { status: 403 })))(
      timeframe,
    ),
    { message: "Workers Logs HTTP 403" },
  );
});
await test("refuses possibly truncated results", async () => {
  await assert.rejects(
    query(envelope(Array.from({ length: 2000 }, () => event))),
    /hit the 2000-row limit; narrow the time range/u,
  );
});
await test("requests the full window once and preserves ties and source fields", async () => {
  const rows = await workersLogs("test", (_url, init) => {
    assert.ok(typeof init?.body === "string");
    assert.deepEqual(JSON.parse(init.body), {
      queryId: "adhoc",
      dry: true,
      view: "events",
      limit: 2000,
      timeframe,
      parameters: {},
    });
    return Promise.resolve(
      Response.json(
        envelope([
          event,
          { ...event, timestamp: 1, source: { x: 1, t: 99, service: "old" } },
          { ...event, source: "two" },
        ]),
      ),
    );
  })(timeframe);
  assert.deepEqual(rows, [
    { x: 1, t: 1, service: "staging" },
    { message: "one", t: 3, service: "staging" },
    { message: "two", t: 3, service: "staging" },
  ]);
  assert.deepEqual(parseLogRows(formatLogRows(rows)), rows);
  assert.throws(() => parseLogRows(formatLogRows(rows) + "{}"), /line 4/u);
});
