import { useEffect, useReducer, useRef, useState } from "react";
import { createProject, listProjects } from "./api.ts";
import { failureMessage } from "./failure.ts";
import { formatDateTime } from "./format-date-time.ts";
import { navigate, RouteLink } from "./navigation.tsx";
import {
  beginCreate,
  finishCreate,
  cursorToLoad,
  initialProjectList,
  reduceProjectList,
  type CreateAttempt,
} from "./project-list.ts";
import { projectRoute, parseProjectId } from "./route.ts";

export function ProjectListScreen() {
  const [list, dispatch] = useReducer(reduceProjectList, initialProjectList);
  const [attempt, setAttempt] = useState<CreateAttempt>({ kind: "idle" });
  const alive = useRef<AbortSignal | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller.signal;
    return () => controller.abort();
  }, []);
  const first = list.kind === "loading";
  const cursor = cursorToLoad(list);
  useEffect(() => {
    if (!first && cursor === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    void listProjects(cursor, signal).then(
      (page) => {
        if (!signal.aborted)
          dispatch(
            cursor === null ? { kind: "first_page", page } : { kind: "next_page", page, cursor },
          );
      },
      (error: unknown) => {
        if (signal.aborted) return;
        const message = failureMessage(error);
        dispatch(
          cursor === null
            ? { kind: "first_page_failed", message }
            : { kind: "next_page_failed", cursor, message },
        );
      },
    );
    return () => controller.abort();
  }, [first, cursor]);
  async function onCreate() {
    const signal = alive.current;
    if (!signal || signal.aborted) return;
    const sending = beginCreate(attempt);
    if (!sending) return;
    setAttempt(sending);
    try {
      const { project } = await createProject({ requestId: sending.requestId }, signal);
      if (signal.aborted) return;
      setAttempt(finishCreate(sending, null));
      navigate(projectRoute(parseProjectId(project.id)));
    } catch (error) {
      if (!signal.aborted) setAttempt(finishCreate(sending, failureMessage(error)));
    }
  }
  return (
    <>
      <h1>案件一覧</h1>
      {attempt.kind === "failed" ? (
        <p role="alert">
          {attempt.message} <button onClick={() => void onCreate()}>再試行</button>
        </p>
      ) : (
        <button disabled={attempt.kind === "sending"} onClick={() => void onCreate()}>
          {attempt.kind === "sending" ? "作成中…" : "新しい案件を作る"}
        </button>
      )}
      {list.kind === "loading" && <p role="status">読み込み中…</p>}
      {list.kind === "failed" && (
        <p role="alert">
          {list.message} <button onClick={() => dispatch({ kind: "retry_first" })}>再試行</button>
        </p>
      )}
      {list.kind === "loaded" && (
        <>
          {list.projects.length === 0 ? (
            <p>まだ案件がありません。</p>
          ) : (
            <ul className="project-list">
              {list.projects.map((project) => (
                <li key={project.id}>
                  <RouteLink to={projectRoute(parseProjectId(project.id))}>
                    {project.name}{" "}
                    <time dateTime={project.createdAt}>{formatDateTime(project.createdAt)}</time>
                  </RouteLink>
                </li>
              ))}
            </ul>
          )}
          {list.more.kind === "available" && (
            <button onClick={() => dispatch({ kind: "more_requested" })}>もっと見る</button>
          )}
          {list.more.kind === "loading" && <p role="status">読み込み中…</p>}
          {list.more.kind === "failed" && (
            <p role="alert">
              {list.more.message}{" "}
              <button onClick={() => dispatch({ kind: "more_requested" })}>再試行</button>
            </p>
          )}
        </>
      )}
    </>
  );
}
