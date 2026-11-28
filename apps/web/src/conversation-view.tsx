import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AssetImages } from "./asset-images.ts";
import type { AttachmentDraft } from "./attachments.ts";
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
    case "rejected":
      return null;
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
type OpenImage = { url: string; label: string };

function AttachmentThumbnail({
  id,
  label,
  images,
  onOpen,
}: {
  id: string;
  label: string;
  images: AssetImages;
  onOpen: (image: OpenImage) => void;
}) {
  const element = useRef<HTMLLIElement>(null);
  const read = () => images.get(id);
  const image = useSyncExternalStore(images.subscribe, read, read);
  useEffect(() => {
    if (images.get(id)) return;
    if (typeof IntersectionObserver === "undefined") {
      void images.load(id);
      return;
    }
    const node = element.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void images.load(id);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [images, id]);

  return (
    <li ref={element}>
      {image?.kind === "ready" ? (
        <button
          className="attachment-thumbnail"
          type="button"
          aria-label={`${label}を拡大`}
          onClick={() => onOpen({ url: image.url, label })}
        >
          <img src={image.url} alt={label} />
        </button>
      ) : (
        <span className="attachment-placeholder">
          {image?.kind === "failed" ? "画像を読み込めませんでした" : "画像"}
        </span>
      )}
    </li>
  );
}

export function ConversationLog({
  timeline,
  onResend,
  images,
}: {
  timeline: readonly TimelineEntry[];
  onResend: (id: string) => void;
  images: AssetImages;
}) {
  const log = useRef<HTMLOListElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<OpenImage | null>(null);
  function openImage(image: OpenImage) {
    setSelected(image);
    dialog.current?.showModal();
  }
  const last = timeline.at(-1);
  const tail = `${timeline.length}:${last ? (statusText(last) ?? "") : ""}`;
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [tail]);
  return (
    <>
      <ol className="conversation-log" ref={log}>
        {timeline.map((entry) => {
          const message = entry.kind === "server" ? entry.message : null;
          const kind =
            message?.kind ??
            (entry.kind === "local" && entry.questionId !== null ? "answer" : "instruction");
          const attachmentIds =
            entry.kind === "local" ? entry.attachmentIds : entry.message.attachmentIds;
          const appearance = appearances[kind];
          const status = statusText(entry);
          return (
            <li key={entry.key} className={`entry entry-${kind}`} role={appearance.role}>
              <strong>{appearance.speaker}</strong>{" "}
              {status && <span className="delivery-badge">{status}</span>}
              <p>{entry.kind === "local" ? entry.body : entry.message.body}</p>
              {attachmentIds.length > 0 && (
                <ul className="attachment-list" aria-label="添付画像">
                  {attachmentIds.map((id, index) => (
                    <AttachmentThumbnail
                      key={id}
                      id={id}
                      label={`添付画像${index + 1}`}
                      images={images}
                      onOpen={openImage}
                    />
                  ))}
                </ul>
              )}
              {message && appearance.detail?.(message)}
              {entry.kind === "local" &&
                (entry.delivery.kind === "unsent" || entry.delivery.kind === "rejected") && (
                  <div>
                    {entry.delivery.kind === "unsent"
                      ? entry.delivery.message
                      : "質問は既に閉じていたため、回答として送れませんでした。"}{" "}
                    <button type="button" onClick={() => onResend(entry.requestId)}>
                      {entry.delivery.kind === "unsent" ? "再送" : "指示として送る"}
                    </button>
                  </div>
                )}
            </li>
          );
        })}
      </ol>
      <dialog
        className="attachment-dialog"
        aria-label={selected?.label}
        ref={dialog}
        onClose={() => setSelected(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="attachment-dialog-content">
          <button type="button" onClick={() => dialog.current?.close()}>
            閉じる
          </button>
          {selected && <img src={selected.url} alt={selected.label} />}
        </div>
      </dialog>
    </>
  );
}
export function InstructionForm({
  onSend,
  hint,
  drafts,
  attachNotice,
  preparingAttachments,
  onAttach,
  onDetach,
  onRetryAttachment,
}: {
  onSend: (body: InstructionBody) => boolean;
  hint?: string | undefined;
  drafts: readonly AttachmentDraft[];
  attachNotice: string | null;
  preparingAttachments: boolean;
  onAttach: (files: readonly Blob[]) => void;
  onDetach: (key: string) => void;
  onRetryAttachment: (key: string) => void;
}) {
  const [text, setText] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const checked = checkInstruction(text);
  const blocked = preparingAttachments || drafts.some(({ state }) => state.kind !== "ready");
  const uploading = drafts.some(({ state }) => state.kind === "uploading");
  return (
    <form
      className="instruction-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok && !blocked && onSend(checked.body)) setText("");
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        onAttach(files);
      }}
    >
      <textarea
        aria-label="指示"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const images = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (!images.length) return;
          event.preventDefault();
          onAttach(images);
        }}
      />
      <input
        type="file"
        accept="image/*"
        multiple
        hidden
        ref={picker}
        onChange={(event) => {
          const input = event.currentTarget;
          if (input.files) onAttach(Array.from(input.files));
          input.value = "";
        }}
      />
      <button type="button" onClick={() => picker.current?.click()}>
        画像を添える
      </button>
      {drafts.length > 0 && (
        <ul className="attachment-list" aria-label="送信前の添付画像">
          {drafts.map(({ key, previewUrl, state }, index) => {
            const label = `添付画像${index + 1}`;
            return (
              <li key={key} className="attachment-draft">
                {previewUrl && <img className="attachment-preview" src={previewUrl} alt={label} />}
                {state.kind === "uploading" && <span>登録中…</span>}
                {state.kind === "failed" && <span>{state.message}</span>}
                <button
                  type="button"
                  aria-label={`${label}を取り消す`}
                  onClick={() => onDetach(key)}
                >
                  取り消し
                </button>
                {state.kind === "failed" && state.retryable && (
                  <button type="button" onClick={() => onRetryAttachment(key)}>
                    再試行
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {attachNotice && <p role="alert">{attachNotice}</p>}
      {(preparingAttachments || uploading) && (
        <p role="status">{uploading ? "画像を登録しています…" : "画像を準備しています…"}</p>
      )}
      {hint && <p>{hint}</p>}
      {!checked.ok && checked.message && <p role="alert">{checked.message}</p>}
      <button type="submit" disabled={!checked.ok || blocked}>
        送信
      </button>
    </form>
  );
}
