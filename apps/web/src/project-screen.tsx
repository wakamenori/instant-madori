import { useEffect, useState } from "react";
import { watchProject, type ProjectView } from "./project-session.ts";
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
  const [view, setView] = useState<ProjectView>({ kind: "opening" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void watchProject({ projectId, signal: controller.signal, onView: setView });
    return () => controller.abort();
  }, [projectId, generation]);
  function retry() {
    setView((current) =>
      current.kind === "open" ? { ...current, problem: null } : { kind: "opening" },
    );
    setGeneration((n) => n + 1);
  }
  const problem =
    view.kind === "failed" ? view.message : view.kind === "open" ? view.problem : null;
  return (
    <>
      <RouteLink to={projectsRoute}>案件一覧</RouteLink>
      {view.kind === "opening" && <p role="status">案件を開いています…</p>}
      {view.kind === "not_found" && <p role="alert">この案件は見つかりません。</p>}
      {view.kind === "open" && (
        <>
          <h1>{view.pattern.name}</h1>
          <p>
            <time dateTime={view.pattern.createdAt}>{formatDateTime(view.pattern.createdAt)}</time>{" "}
            作成
          </p>
          <p>
            {view.shown
              ? `案${view.shown.revision.number}「${view.shown.revision.name}」を表示しています。`
              : "まだ案がありません。"}
          </p>
          {view.activity.kind !== "idle" && <p role="status">{activityText(view.activity)}</p>}
        </>
      )}
      {problem && (
        <p role="alert">
          {problem} <button onClick={retry}>再試行</button>
        </p>
      )}
      {view.kind === "open" && (
        <ModelViewport label="住宅モデル" display={view.shown?.display ?? null} />
      )}
    </>
  );
}
