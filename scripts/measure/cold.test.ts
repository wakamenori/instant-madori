import assert from "node:assert/strict";
import { test } from "node:test";
import { coldness, waitCold } from "./cold.ts";
const row = (event: string, t = 1) => ({ t, event, service: "worker" });
const exit = { t: 20, message: "Container exited (code: 0)", service: "runtime" };
await test("accounts for adoption, concurrent starts, delayed exits and equal timestamps", () => {
  assert.deepEqual(coldness([row("container.adopted")], 500000), {
    kind: "warm",
    alive: 1,
    lastLiveAt: 1,
  });
  assert.deepEqual(coldness([row("container.started"), exit], 300020), {
    kind: "cold",
    exitAt: 20,
  });
  assert.deepEqual(coldness([exit], 300019), { kind: "settling", exitAt: 20 });
  assert.deepEqual(coldness([row("container.started", 20), exit], 500000), {
    kind: "warm",
    alive: 1,
    lastLiveAt: 20,
  });
  assert.deepEqual(
    coldness(
      [
        row("container.started"),
        row("container.started", 2),
        exit,
        row("container.idle_stopped", 21),
      ],
      500000,
    ),
    { kind: "warm", alive: 1, lastLiveAt: 2 },
  );
  assert.deepEqual(coldness([row("container.new")], 500000), {
    kind: "warm",
    alive: 1,
    lastLiveAt: 1,
  });
  assert.deepEqual(coldness([row("cron")], 500000), { kind: "quiet" });
  assert.deepEqual(coldness([], 500000), { kind: "empty" });
});
await test("polls a rolling two-hour window until the exit settles", async () => {
  let at = 300019;
  const reported: string[] = [];
  const result = await waitCold({
    query: (window) => {
      assert.deepEqual(window, { from: at - 7200000, to: at });
      return Promise.resolve([exit]);
    },
    now: () => at,
    sleep: (ms) => {
      assert.equal(ms, 30000);
      at += ms;
      return Promise.resolve();
    },
    report: (v) => reported.push(v.kind),
  });
  assert.deepEqual(reported, ["settling", "cold"]);
  assert.deepEqual(result, { kind: "cold", exitAt: 20 });
});
