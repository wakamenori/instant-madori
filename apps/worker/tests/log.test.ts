import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "../src/log.ts";

await test("an unexpected error is logged with everything it wraps", () => {
  const batch = new Error("UNIQUE constraint failed: requests.owner_id");
  const lookup = new TypeError("D1 unavailable", { cause: new Error("network down") });
  const wrapped = new AggregateError([batch, lookup], "project.create: batch failed");
  assert.equal(
    describeError(wrapped),
    "AggregateError: project.create: batch failed" +
      " <- Error: UNIQUE constraint failed: requests.owner_id" +
      " <- TypeError: D1 unavailable <- Error: network down",
  );
  assert.equal(describeError("thrown string"), "string");
});
