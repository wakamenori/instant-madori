import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConversationMessage } from "@madori/contracts";
import {
  checkInstruction,
  type InstructionBody,
  type TimelineEntry,
  type Progress,
} from "./conversation.ts";

type MessageAppearance = {
  speaker: string;
  role?: "note";
  detail?: (message: ConversationMessage) => ReactNode;
};
const appearances: Record<ConversationMessage["kind"], MessageAppearance> = {
  instruction: { speaker: "指示" },
  answer: { speaker: "回答" },
  explanation: {
    speaker: "AI",
    detail: ({ revision }) =>
      revision && (
        <small>
          案{revision.number}「{revision.name}」
        </small>
      ),
  },
  question: {
    speaker: "AIの質問",
    detail: (message) =>
      message.kind === "question" && (
        <ul className="choices">
          {message.choices.map((choice, index) => (
            <li key={index}>{choice}</li>
          ))}
        </ul>
      ),
  },
  notice: { speaker: "お知らせ", role: "note" },
};
function statusText(entry: TimelineEntry) {
  if (entry.kind === "server") return entry.progress && badge(entry.progress);
  switch (entry.delivery.kind) {
    case "accepted":
      return badge(entry.delivery.progress);
    case "sending":
      return "送信中…";
    case "unsent":
      return "未送信";
  }
}
function badge(progress: Progress) {
  switch (progress.kind) {
    case "settled":
      return null;
    case "waiting":
      return `待機中（${progress.position}番目）`;
    case "running":
      return "実行中";
    case "accepted":
      return "受付済み";
    case "held":
      return "保留中";
  }
}
export function ConversationLog({
  timeline,
  onResend,
}: {
  timeline: readonly TimelineEntry[];
  onResend: (id: string) => void;
}) {
  const log = useRef<HTMLOListElement>(null);
  const last = timeline.at(-1);
  const tail = `${timeline.length}:${last ? (statusText(last) ?? "") : ""}`;
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [tail]);
  return (
    <ol className="conversation-log" ref={log}>
      {timeline.map((entry) => {
        const message = entry.kind === "server" ? entry.message : null;
        const kind = message?.kind ?? "instruction";
        const appearance = appearances[kind];
        const status = statusText(entry);
        return (
          <li key={entry.key} className={`entry entry-${kind}`} role={appearance.role}>
            <strong>{appearance.speaker}</strong>{" "}
            {status && <span className="delivery-badge">{status}</span>}
            <p>{entry.kind === "local" ? entry.body : entry.message.body}</p>
            {message && appearance.detail?.(message)}
            {entry.kind === "local" && entry.delivery.kind === "unsent" && (
              <div>
                {entry.delivery.message}{" "}
                <button type="button" onClick={() => onResend(entry.requestId)}>
                  再送
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
export function InstructionForm({ onSend }: { onSend: (body: InstructionBody) => void }) {
  const [text, setText] = useState("");
  const checked = checkInstruction(text);
  return (
    <form
      className="instruction-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok) {
          onSend(checked.body);
          setText("");
        }
      }}
    >
      <textarea
        aria-label="指示"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {!checked.ok && checked.message && <p role="alert">{checked.message}</p>}
      <button type="submit" disabled={!checked.ok}>
        送信
      </button>
    </form>
  );
}
