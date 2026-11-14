import assert from "node:assert/strict";
import { test } from "node:test";
import { finishDevelopment } from "./dev-session.ts";
import { cleanupSteps } from "../shared/processes.ts";
void test("development settles its outcome before cleanup failures", async (t) => {
  const previous = process.exitCode;
  t.after(() => {
    process.exitCode = previous;
  });
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    reports.push(args);
  });
  const original = new Error("original spawn failure");
  const cleanup = new Error("spawnSync docker ENOENT");
  for (const [result, interrupted, expected] of [
    [{ kind: "exit", code: 0, signal: null }, true, 0],
    [{ kind: "exit", code: 17, signal: null }, false, 17],
    [{ kind: "error", error: original }, false, 1],
  ] as const) {
    let cleaned = false;
    const observed: (typeof process.exitCode)[] = [];
    await finishDevelopment(result, interrupted, {
      stop: () => {
        observed.push(process.exitCode);
        throw new Error("dispose failure");
      },
      cleanup: () => {
        cleaned = true;
        throw cleanup;
      },
    });
    assert.deepEqual(observed, [expected]);
    assert(cleaned);
    assert.equal(process.exitCode, expected);
  }
  assert(reports.some((args) => args.includes(original)));
  assert(reports.some((args) => args.includes(cleanup)));
});
void test("cleanup attempts each step even after disposal fails", async () => {
  const events: string[] = [];
  const dispose = new Error("dispose");
  const cleanup = new Error("cleanup");
  const problems = await cleanupSteps([
    () => {
      events.push("dispose");
      throw dispose;
    },
    () => {
      events.push("cleanup");
      throw cleanup;
    },
    () => {
      events.push("remove");
    },
  ]);
  assert.deepEqual(events, ["dispose", "cleanup", "remove"]);
  assert.deepEqual(problems, [dispose, cleanup]);
});
