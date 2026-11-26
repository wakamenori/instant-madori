import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline, checkInstruction, mergeRows, type OutboxEntry } from "./conversation.ts";
import type { ConversationMessage } from "@madori/contracts";

void test("numbered rows share their key with local acceptances; pending deliveries sort last by sequence", () => {
  const checked = checkInstruction("指示");
  assert.ok(checked.ok);
  const local = {
    body: checked.body,
    requestId: "b",
    seq: 2,
    delivery: { kind: "sending" },
  } as const;
  const outbox: OutboxEntry[] = [
    local,
    { ...local, seq: 1, requestId: "a", delivery: { kind: "unsent", message: "未送信" } },
    {
      ...local,
      requestId: "c",
      delivery: { kind: "accepted", job: { messageId: "m2", jobId: "j", number: 2 } },
    },
  ];
  function row(number: number): ConversationMessage {
    return {
      id: "m" + String(number),
      number,
      kind: "instruction",
      jobId: null,
      body: "指示",
      revision: null,
      attachmentIds: [],
      createdAt: "2026-01-01T00:00:00Z",
    };
  }
  const rows = mergeRows(new Map(), [row(3), row(1)]);
  const before = buildTimeline(rows, outbox, null);
  const after = buildTimeline(mergeRows(rows, [row(3), row(2)]), outbox, null);
  const keys = ["message:m1", "message:m2", "message:m3", "request:a", "request:b"];
  assert.deepEqual(
    before.map((e) => e.key),
    keys,
  );
  assert.deepEqual(
    after.map((e) => e.key),
    keys,
  );
  const accepted = before[1];
  assert.ok(
    accepted?.kind === "local" &&
      accepted.delivery.kind === "accepted" &&
      accepted.delivery.progress.kind === "accepted",
  );
  assert.equal(after[1]?.kind, "server");
});
void test("instruction validation preserves the body and explains invalid input", () => {
  assert.deepEqual(checkInstruction("  改築  "), { ok: true, body: "  改築  " });
  assert.deepEqual(checkInstruction("  "), { ok: false, message: null });
  assert.deepEqual(checkInstruction("あ".repeat(5500)), {
    ok: false,
    message: "指示が長すぎます（16384バイトまで）。",
  });
  assert.deepEqual(checkInstruction("\uD800"), {
    ok: false,
    message: "使えない文字が含まれています。",
  });
});
