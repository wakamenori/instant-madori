import { useState } from "react";
import { checkInstruction, type InstructionBody } from "./conversation.ts";
import type {
  Action,
  HoldCause,
  OpenQuestion,
  PatternStatus,
  Receipt,
  StatusView,
} from "./pattern-status.ts";

type Panel = {
  line: string | null;
  notes: readonly string[];
  receipt: { text: string; alert: boolean } | null;
  buttons: readonly {
    label: string;
    busyLabel: string;
    action: Action;
    disabled: boolean;
    busy: boolean;
  }[];
  retry: boolean;
};

const actionCopy = {
  stop: {
    label: "止める",
    busyLabel: "止めています…",
    uncertain: "停止",
    failed: "止められませんでした。",
  },
  resume: {
    label: "再開する",
    busyLabel: "再開しています…",
    uncertain: "再開",
    failed: "再開できませんでした。",
  },
  cancel: {
    label: "取り消す",
    busyLabel: "取り消しています…",
    uncertain: "取り消し",
    failed: "取り消せませんでした。",
  },
};

const lastLine = {
  cancelled: "最後の指示は止めました。途中の変更は採用していません。",
  failed: "最後の指示は完了できませんでした。途中の変更は採用していません。",
  limited: "最後の指示は上限に達したため終了しました。途中の変更は採用していません。",
};

function heldPrefix(cause: HoldCause): string {
  switch (cause.kind) {
    case "stopped":
      return "指示を止めたため、";
    case "failed":
      return "指示を完了できなかったため、";
    case "limited":
      return "上限に達して指示を終了したため、";
    case "answered":
      switch (cause.ending) {
        case "completed":
          if (cause.revision)
            return `回答をもとに案${cause.revision.number}「${cause.revision.name}」を確定しました。`;
          return "回答の処理が終わりました。";
        case "cancelled":
          return "回答の処理を止めたため、";
        case "failed":
          return "回答の処理を完了できなかったため、";
        case "limited":
          return "上限に達して回答の処理を終了したため、";
        case null:
          return "回答の処理が終わりました。";
      }
  }
}

function statusCopy(
  now: PatternStatus,
): Pick<Panel, "line" | "notes"> & { actions: readonly Action[] } {
  switch (now.kind) {
    case "idle":
      return { line: now.last ? lastLine[now.last.kind] : null, notes: [], actions: [] };
    case "starting":
      return { line: `順番を待っています（${now.waiting}件）…`, notes: [], actions: [] };
    case "running":
      return {
        line: "指示を実行しています…",
        notes:
          now.waiting > 0
            ? [`待機中の指示が${now.waiting}件あります。止めると、待機中の指示は保留になります。`]
            : [],
        actions: now.stop ? [now.stop] : [],
      };
    case "asking":
      return {
        line: "AIが質問しています。選択肢を選ぶか、回答を書いて送ってください。",
        notes:
          now.held > 0
            ? [
                `待機中の指示（${now.held}件）は保留しています。回答は保留中の指示より先に実行します。答えずに再開か取り消しを選ぶと、質問は閉じます。`,
              ]
            : [],
        actions: now.release ? [now.release.resume, now.release.cancel] : [],
      };
    case "answering":
      return {
        line: "AIが回答をもとに作業しています…",
        notes:
          now.held > 0
            ? [`待機中の指示（${now.held}件）は、回答の処理が終わるまで保留しています。`]
            : [],
        actions: now.stop ? [now.stop] : [],
      };
    case "held":
      return {
        line: `${heldPrefix(now.cause)}待機中の指示（${now.held}件）を保留しています。`,
        notes: ["再開すると受付順に実行し、取り消すと待機中の指示をすべて取り消します。"],
        actions: now.release ? [now.release.resume, now.release.cancel] : [],
      };
  }
}

const finishedFirstLine = {
  awaiting_answer: "止める前に、AIが質問をして指示を終えていました。",
  failed: "止める前に、指示は完了できずに終わっていました。",
  limited: "止める前に、指示は上限に達して終わっていました。",
  cancelled: "指示は既に止まっていました。",
};

function receiptText(receipt: Receipt): string {
  switch (receipt.kind) {
    case "stopped":
      return "指示を止めました。";
    case "finished_first":
      return receipt.ending === "completed"
        ? `止める前に指示が完了し、案${receipt.revision.number}「${receipt.revision.name}」を確定していました。`
        : finishedFirstLine[receipt.ending];
    case "released":
      return `待機中の指示（${receipt.count}件）を${receipt.how === "resume" ? "再開し" : "取り消し"}ました。${receipt.closedQuestion ? "質問は閉じました。" : ""}`;
    case "conflict":
      return "保留の状態が変わっていたため、操作しませんでした。最新の状態から選び直してください。";
    case "failed": {
      const copy = actionCopy[receipt.action];
      return receipt.uncertain
        ? `${copy.uncertain}の結果を確認できませんでした。接続を確認して、もう一度送ってください。`
        : copy.failed;
    }
  }
}

export function statusPanel(view: StatusView): Panel {
  const { line, notes, actions } = statusCopy(view.now);
  return {
    line,
    notes,
    buttons: actions.map((action) => {
      const { label, busyLabel } = actionCopy[action.kind];
      return {
        label,
        busyLabel,
        action,
        disabled: view.pending !== null,
        busy: view.pending === action.kind,
      };
    }),
    receipt: view.receipt
      ? {
          text: receiptText(view.receipt),
          alert: view.receipt.kind === "failed" || view.receipt.kind === "conflict",
        }
      : null,
    retry: view.canRetry,
  };
}

export function instructionHint(status: PatternStatus): string | undefined {
  if (status.kind !== "asking") return undefined;
  return status.held === 0
    ? "指示を送ると質問は閉じ、AIはその指示を回答として読みます。"
    : "指示を送ると、保留中の指示の後ろに加わります。";
}

function AnswerControls({
  question,
  disabled,
  onAnswer,
}: {
  question: OpenQuestion;
  disabled: boolean;
  onAnswer: (question: OpenQuestion, body: InstructionBody) => void;
}) {
  const [text, setText] = useState("");
  const checked = checkInstruction(text);
  return (
    <>
      <p>{question.body}</p>
      {question.choices.length > 0 && (
        <div role="group" aria-label="選択肢">
          {question.choices.map((choice, index) => {
            const option = checkInstruction(choice);
            return (
              <button
                key={index}
                type="button"
                disabled={disabled || !option.ok}
                onClick={() => {
                  if (option.ok) onAnswer(question, option.body);
                }}
              >
                {choice}
              </button>
            );
          })}
        </div>
      )}
      <form
        aria-label="回答"
        onSubmit={(event) => {
          event.preventDefault();
          if (checked.ok && !disabled) {
            onAnswer(question, checked.body);
            setText("");
          }
        }}
      >
        <textarea
          aria-label="回答"
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
        {!checked.ok && checked.message && <p role="alert">{checked.message}</p>}
        <button type="submit" disabled={disabled || !checked.ok}>
          回答を送る
        </button>
      </form>
    </>
  );
}

export function StatusPanel({
  view,
  inputInFlight,
  onAct,
  onAnswer,
  onRetry,
}: {
  view: StatusView;
  inputInFlight: boolean;
  onAct: (action: Action) => void;
  onAnswer: (question: OpenQuestion, body: InstructionBody) => void;
  onRetry: () => void;
}) {
  const panel = statusPanel(view);
  return (
    <>
      {panel.line && <p role="status">{panel.line}</p>}
      {panel.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {view.now.kind === "asking" && (
        <AnswerControls
          key={view.now.question.messageId}
          question={view.now.question}
          disabled={inputInFlight || view.pending !== null}
          onAnswer={onAnswer}
        />
      )}
      {panel.buttons.map(({ action, disabled, busy, label, busyLabel }) => (
        <button key={action.kind} type="button" disabled={disabled} onClick={() => onAct(action)}>
          {busy ? busyLabel : label}
        </button>
      ))}
      {panel.receipt && <p role={panel.receipt.alert ? "alert" : "status"}>{panel.receipt.text}</p>}
      {panel.retry && (
        <button
          type="button"
          disabled={
            inputInFlight && view.receipt?.kind === "failed" && view.receipt.action !== "stop"
          }
          onClick={onRetry}
        >
          もう一度送る
        </button>
      )}
    </>
  );
}
