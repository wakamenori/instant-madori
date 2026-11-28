import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeStatus,
  isWorking,
  type Ending,
  type LastOutcome,
  type ReleaseActions,
} from "./pattern-status.ts";
import { answer, question, revision, root, statusStates } from "./pattern-status.test-fixtures.ts";

const openQuestion = {
  messageId: question.messageId,
  body: question.body,
  choices: question.choices,
};
const release = {
  resume: { kind: "resume", heldBy: root.jobId },
  cancel: { kind: "cancel", heldBy: root.jobId },
} satisfies { [Kind in keyof ReleaseActions]: Pick<ReleaseActions[Kind], "kind" | "heldBy"> };
const held = { kind: "held", held: 2, release };
const asking = { kind: "asking", question: openQuestion, held: 2, release };
const idle = (last: LastOutcome) => ({ kind: "idle", last });
const answered = (ending: Ending | null) => ({
  ...held,
  cause: { kind: "answered", ending, revision: ending === "completed" ? revision : null },
});
const expectations = {
  idle: [idle(null), false],
  "idle completed": [idle(null), false],
  "idle closed question": [idle(null), false],
  "idle cancelled": [idle({ kind: "cancelled" }), false],
  "idle failed": [idle({ kind: "failed" }), false],
  "idle limited": [idle({ kind: "limited" }), false],
  starting: [{ kind: "starting", waiting: 2 }, true],
  running: [{ kind: "running", waiting: 0, stop: { kind: "stop", jobId: root.jobId } }, true],
  "running with waiting": [
    { kind: "running", waiting: 2, stop: { kind: "stop", jobId: root.jobId } },
    true,
  ],
  "running inside hold": [
    { kind: "running", waiting: 2, stop: { kind: "stop", jobId: answer.jobId } },
    true,
  ],
  "asking without held": [{ ...asking, held: 0, release: null }, false],
  asking: [asking, false],
  "answering queued": [{ kind: "answering", held: 2, stop: null }, true],
  "answering running": [
    { kind: "answering", held: 2, stop: { kind: "stop", jobId: answer.jobId } },
    true,
  ],
  "held stopped": [{ ...held, cause: { kind: "stopped" } }, false],
  "held failed": [{ ...held, cause: { kind: "failed" } }, false],
  "held limited": [{ ...held, cause: { kind: "limited" } }, false],
  "answered completed": [answered("completed"), false],
  "answered cancelled": [answered("cancelled"), false],
  "answered failed": [answered("failed"), false],
  "answered limited": [answered("limited"), false],
  "answered unknown": [answered(null), false],
} satisfies Record<keyof typeof statusStates, [unknown, boolean]>;

for (const name in expectations) {
  const key = name as keyof typeof expectations;
  const [expected, working] = expectations[key];
  void test(key, () => {
    const status = describeStatus(statusStates[key], { inputInFlight: false });
    assert.deepEqual(status, expected);
    assert.equal(isWorking(status), working);
  });
}

void test("an input in flight withholds the asking and held release tokens", () => {
  for (const key of ["asking", "held failed"] as const) {
    const status = describeStatus(statusStates[key], { inputInFlight: true });
    assert.ok(status.kind === "asking" || status.kind === "held");
    assert.equal(status.release, null);
  }
});
