import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationMessage } from "@madori/contracts";
import { registerTsx } from "./tsx-test-loader.ts";
import type { TimelineEntry, LocalDelivery } from "./conversation.ts";
void test("conversation kinds, revision, choices and delivery states appear in the log", async () => {
  const hooks = await registerTsx(new URL("./conversation-view.tsx", import.meta.url));
  const { ConversationLog } = await import("./conversation-view.tsx").finally(() =>
    hooks.deregister(),
  );
  const base = {
    id: "id",
    number: 1,
    body: "本文",
    jobId: "job",
    attachmentIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    revision: null,
  };
  const messages: ConversationMessage[] = [
    { ...base, kind: "instruction" },
    { ...base, kind: "answer" },
    { ...base, kind: "notice" },
    { ...base, kind: "question", choices: ["南", "北"] },
    {
      ...base,
      kind: "explanation",
      revision: {
        id: "r",
        number: 2,
        name: "窓",
        patternId: "p",
        baseRevisionId: null,
        createdAt: base.createdAt,
      },
    },
  ];
  const timeline: TimelineEntry[] = messages.map((message, i) => ({
    kind: "server",
    key: String(i),
    message,
    progress: message.kind === "instruction" ? { kind: "running" } : null,
  }));
  const deliveries: LocalDelivery[] = [
    { kind: "accepted", progress: { kind: "waiting", position: 2 } },
    { kind: "accepted", progress: { kind: "held" } },
    { kind: "accepted", progress: { kind: "accepted" } },
    { kind: "sending" },
    { kind: "unsent", message: "接続を確認" },
    { kind: "rejected" },
  ];
  for (const [index, delivery] of deliveries.entries()) {
    const requestId = `request-${index}`;
    timeline.push({
      kind: "local",
      key: requestId,
      requestId,
      questionId: delivery.kind === "rejected" ? "q" : null,
      body: delivery.kind === "rejected" ? "回答本文" : "指示",
      delivery,
    });
  }
  const html = renderToStaticMarkup(
    createElement(ConversationLog, { timeline, onResend: () => {} }),
  );
  for (const [kind, speaker] of Object.entries({
    instruction: "指示",
    answer: "回答",
    question: "AIの質問",
    explanation: "AI",
    notice: "お知らせ",
  }))
    assert.match(html, new RegExp(`class="entry entry-${kind}"[^>]*><strong>${speaker}</strong>`));
  assert.match(html, /class="entry entry-answer"><strong>回答<\/strong> <p>回答本文<\/p>/);
  assert.match(html, /entry-notice" role="note"/);
  assert.match(html, /<ul class="choices"><li>南<\/li><li>北<\/li><\/ul>/);
  for (const label of [
    "案2「窓」",
    "実行中",
    "待機中（2番目）",
    "保留中",
    "受付済み",
    "送信中…",
    "未送信",
    "接続を確認",
    ">再送</button>",
    "質問は既に閉じていたため、回答として送れませんでした。",
    ">指示として送る</button>",
  ])
    assert.ok(html.includes(label), label);
});
