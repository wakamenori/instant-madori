import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeStatus, type Receipt, type StatusView } from "./pattern-status.ts";
import { revision, statusStates } from "./pattern-status.test-fixtures.ts";
import { registerTsx } from "./tsx-test-loader.ts";

const hooks = await registerTsx(new URL("./status-panel.tsx", import.meta.url));
const { StatusPanel, statusPanel, instructionHint } = await import("./status-panel.tsx").finally(
  () => hooks.deregister(),
);

function view(name: keyof typeof statusStates): StatusView {
  return {
    now: describeStatus(statusStates[name], { inputInFlight: false }),
    pending: null,
    receipt: null,
    canRetry: false,
  };
}

const stop = ["止める"];
const release = ["再開する", "取り消す"];
const heldNote = ["再開すると受付順に実行し、取り消すと待機中の指示をすべて取り消します。"];
const heldLine = "待機中の指示（2件）を保留しています。";
const runningNote = ["待機中の指示が2件あります。止めると、待機中の指示は保留になります。"];
const questionLine = "AIが質問しています。選択肢を選ぶか、回答を書いて送ってください。";
const answeringLine = "AIが回答をもとに作業しています…";
const answeringNote = ["待機中の指示（2件）は、回答の処理が終わるまで保留しています。"];
const wording = {
  idle: [null, [], []],
  "idle completed": [null, [], []],
  "idle closed question": [null, [], []],
  "idle cancelled": ["最後の指示は止めました。途中の変更は採用していません。", [], []],
  "idle failed": ["最後の指示は完了できませんでした。途中の変更は採用していません。", [], []],
  "idle limited": [
    "最後の指示は上限に達したため終了しました。途中の変更は採用していません。",
    [],
    [],
  ],
  starting: ["順番を待っています（2件）…", [], []],
  running: ["指示を実行しています…", [], stop],
  "running with waiting": ["指示を実行しています…", runningNote, stop],
  "running inside hold": ["指示を実行しています…", runningNote, stop],
  "asking without held": [questionLine, [], []],
  asking: [
    questionLine,
    [
      "待機中の指示（2件）は保留しています。回答は保留中の指示より先に実行します。答えずに再開か取り消しを選ぶと、質問は閉じます。",
    ],
    release,
  ],
  "answering queued": [answeringLine, answeringNote, []],
  "answering running": [answeringLine, answeringNote, stop],
  "held stopped": ["指示を止めたため、" + heldLine, heldNote, release],
  "held failed": ["指示を完了できなかったため、" + heldLine, heldNote, release],
  "held limited": ["上限に達して指示を終了したため、" + heldLine, heldNote, release],
  "answered completed": ["回答をもとに案3「窓」を確定しました。" + heldLine, heldNote, release],
  "answered cancelled": ["回答の処理を止めたため、" + heldLine, heldNote, release],
  "answered failed": ["回答の処理を完了できなかったため、" + heldLine, heldNote, release],
  "answered limited": ["上限に達して回答の処理を終了したため、" + heldLine, heldNote, release],
  "answered unknown": ["回答の処理が終わりました。" + heldLine, heldNote, release],
} satisfies Record<keyof typeof statusStates, [string | null, string[], string[]]>;

for (const name in wording) {
  const key = name as keyof typeof wording;
  void test(key, () => {
    const { line, notes, buttons } = statusPanel(view(key));
    assert.deepEqual([line, notes, buttons.map((button) => button.label)], wording[key]);
    assert.ok(buttons.every((button) => !button.disabled && !button.busy));
  });
}

void test("pending operations disable all action buttons and give the pressed one its busy label", () => {
  for (const [name, pending, busyLabel] of [
    ["running", "stop", "止めています…"],
    ["asking", "resume", "再開しています…"],
    ["held failed", "cancel", "取り消しています…"],
  ] as const) {
    const panel = statusPanel({ ...view(name), pending });
    assert.ok(panel.buttons.every((button) => button.disabled));
    assert.deepEqual(
      panel.buttons.filter((button) => button.busy).map((button) => button.busyLabel),
      [busyLabel],
    );
  }
});

const receipts: [Receipt, string, boolean][] = [
  [{ kind: "stopped" }, "指示を止めました。", false],
  [
    { kind: "finished_first", ending: "completed", revision },
    "止める前に指示が完了し、案3「窓」を確定していました。",
    false,
  ],
  [
    { kind: "finished_first", ending: "awaiting_answer" },
    "止める前に、AIが質問をして指示を終えていました。",
    false,
  ],
  [
    { kind: "finished_first", ending: "failed" },
    "止める前に、指示は完了できずに終わっていました。",
    false,
  ],
  [
    { kind: "finished_first", ending: "limited" },
    "止める前に、指示は上限に達して終わっていました。",
    false,
  ],
  [{ kind: "finished_first", ending: "cancelled" }, "指示は既に止まっていました。", false],
  [
    { kind: "released", how: "resume", count: 2, closedQuestion: false },
    "待機中の指示（2件）を再開しました。",
    false,
  ],
  [
    { kind: "released", how: "cancel", count: 1, closedQuestion: true },
    "待機中の指示（1件）を取り消しました。質問は閉じました。",
    false,
  ],
  [
    { kind: "conflict" },
    "保留の状態が変わっていたため、操作しませんでした。最新の状態から選び直してください。",
    true,
  ],
  [
    { kind: "failed", action: "stop", uncertain: true },
    "停止の結果を確認できませんでした。接続を確認して、もう一度送ってください。",
    true,
  ],
  [
    { kind: "failed", action: "resume", uncertain: true },
    "再開の結果を確認できませんでした。接続を確認して、もう一度送ってください。",
    true,
  ],
  [
    { kind: "failed", action: "cancel", uncertain: true },
    "取り消しの結果を確認できませんでした。接続を確認して、もう一度送ってください。",
    true,
  ],
  [{ kind: "failed", action: "stop", uncertain: false }, "止められませんでした。", true],
  [{ kind: "failed", action: "resume", uncertain: false }, "再開できませんでした。", true],
  [{ kind: "failed", action: "cancel", uncertain: false }, "取り消せませんでした。", true],
];

for (const [receipt, text, alert] of receipts) {
  void test(text, () => {
    const canRetry = receipt.kind === "failed" && receipt.uncertain;
    const panel = statusPanel({ ...view("idle"), receipt, canRetry });
    assert.deepEqual(panel.receipt, { text, alert });
    assert.equal(panel.retry, canRetry);
  });
}

function render(status: StatusView, inputInFlight = false) {
  return renderToStaticMarkup(
    createElement(StatusPanel, {
      view: status,
      inputInFlight,
      onAct: () => {},
      onAnswer: () => {},
      onRetry: () => {},
    }),
  );
}

void test("the panel renders answer controls from the open question and disables them during input and operations", () => {
  const asking = view("asking");
  const html = render(asking);
  assert.match(html, /<p>和室は必要ですか？<\/p>/);
  assert.match(
    html,
    /role="group" aria-label="選択肢"><button type="button">必要<\/button><button type="button">不要<\/button>/,
  );
  assert.match(
    html,
    /<form aria-label="回答"><textarea aria-label="回答"[^>]*>.*回答を送る<\/button>/,
  );
  for (const disabled of [render(asking, true), render({ ...asking, pending: "resume" })]) {
    assert.match(disabled, /<button type="button" disabled="">必要<\/button>/);
    assert.match(disabled, /<textarea aria-label="回答"[^>]*disabled=""/);
  }
  for (const key of ["idle", "running", "answering running", "answered completed"] as const) {
    assert.doesNotMatch(
      render(view(key)),
      /aria-label="回答"|aria-label="選択肢"|和室は必要ですか？/,
    );
    assert.equal(instructionHint(view(key).now), undefined);
  }
  assert.equal(instructionHint(asking.now), "指示を送ると、保留中の指示の後ろに加わります。");
  assert.equal(
    instructionHint(view("asking without held").now),
    "指示を送ると質問は閉じ、AIはその指示を回答として読みます。",
  );
});
