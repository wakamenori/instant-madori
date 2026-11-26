import { ConversationLog, InstructionForm } from "./conversation-view.tsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createProjectSession, type ProjectView } from "./project-session.ts";
import { RouteLink } from "./navigation.tsx";
import { projectsRoute, type ProjectId } from "./route.ts";
import { formatDateTime } from "./format-date-time.ts";
import { ModelViewport } from "./viewer/model-viewport.tsx";

function activityText(activity: Extract<ProjectView, { kind: "open" }>["activity"]) {
  switch (activity.kind) {
    case "working":
      return (
        "指示を実行しています…" +
        (activity.queued ? `待機中の指示が${activity.queued}件あります。` : "")
      );
    case "held":
      return `待機中の指示（${activity.queued}件）が保留されています。`;
    case "queued":
      return `順番を待っています（${activity.count}件）…`;
    case "idle":
      return null;
  }
}
export function ProjectScreen({ projectId }: { projectId: ProjectId }) {
  const [session] = useState(() => createProjectSession(projectId));
  useEffect(() => session.start(), [session]);
  const view = useSyncExternalStore(session.subscribe, session.getView);
  const editing =
    view.kind === "open" && (view.activity.kind === "working" || view.activity.kind === "queued");
  return (
    <>
      <RouteLink to={projectsRoute}>案件一覧</RouteLink>
      {view.kind === "opening" && <p role="status">案件を開いています…</p>}
      {view.kind === "not_found" && <p role="alert">この案件は見つかりません。</p>}
      {view.kind === "open" && (
        <div className="project-layout">
          <section>
            <h1>{view.pattern.name}</h1>
            <p>
              <time dateTime={view.pattern.createdAt}>
                {formatDateTime(view.pattern.createdAt)}
              </time>{" "}
              作成
            </p>
            <p>
              {view.shown
                ? `確定済みの案${view.shown.revision.number}「${view.shown.revision.name}」を表示しています。${editing ? "AIが編集中です。" : ""}`
                : editing
                  ? "AIが最初の案を編集中です。"
                  : "まだ案がありません。"}
            </p>
            {view.activity.kind !== "idle" && <p role="status">{activityText(view.activity)}</p>}
            {view.problem && (
              <p role="alert">
                {view.problem} <button onClick={session.retry}>再試行</button>
              </p>
            )}
            <ModelViewport label="住宅モデル" display={view.shown?.display ?? null} />
          </section>
          <section className="conversation-pane" aria-label="会話">
            <ConversationLog timeline={view.timeline} onResend={session.resend} />
            <InstructionForm onSend={session.send} />
          </section>
        </div>
      )}
      {view.kind === "failed" && (
        <p role="alert">
          {view.message} <button onClick={session.retry}>再試行</button>
        </p>
      )}
    </>
  );
}
