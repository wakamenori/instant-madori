import assert from "node:assert/strict";
import { test } from "node:test";
import { runAlarmCycle } from "../../src/objects/alarm-cycle.ts";

for (const outcome of ["throw", "watch", "idle", "wake"]) {
  void test(`alarm cycle preserves its successor or concurrent wake: ${outcome}`, async () => {
    let alarm: number | null = null;
    const calls: string[] = [];
    const storage = {
      setAlarm(time: number | Date) {
        alarm = Number(time);
        calls.push(`arm ${alarm}`);
        return Promise.resolve();
      },
      getAlarm() {
        calls.push("read");
        return Promise.resolve(alarm);
      },
      deleteAlarm() {
        calls.push("delete");
        alarm = null;
        return Promise.resolve();
      },
    };
    await runAlarmCycle({
      storage,
      now: () => 1000,
      reconcile: async () => {
        calls.push("reconcile");
        if (outcome === "throw") throw new Error("unavailable");
        if (outcome === "wake") await storage.setAlarm(1000);
        return outcome === "watch";
      },
      failed: (error) => {
        assert.match(String(error), /unavailable/);
        calls.push("failed");
      },
    });
    assert.deepEqual(calls.slice(0, 2), ["arm 31000", "reconcile"]);
    assert.equal(calls.includes("failed"), outcome === "throw");
    assert.equal(alarm, outcome === "idle" ? null : outcome === "wake" ? 1000 : 31000);
  });
}
