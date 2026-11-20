import { useEffect, useState } from "react";
import { failureMessage, runSample, startNewInstruction } from "./sample-session.ts";
import type { SampleResult, SampleStep } from "./sample-session.ts";
import { ModelViewport } from "./viewer/model-viewport.tsx";

type Status = SampleStep | SampleResult | { kind: "error"; message: string };

export function SampleModel() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "preparing" });
  const [display, setDisplay] = useState<Uint8Array | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void runSample({
      signal,
      onStep: (step) => {
        if (!signal.aborted) setStatus(step);
      },
    })
      .then((result) => {
        if (signal.aborted) return;
        if (result.view) setDisplay(result.view.display);
        setStatus(result);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) setStatus({ kind: "error", message: failureMessage(error) });
      });
    return () => controller.abort();
  }, [attempt]);

  function retry() {
    setStatus({ kind: "preparing" });
    setAttempt((n) => n + 1);
  }
  function sendAgain() {
    try {
      startNewInstruction();
      retry();
    } catch (error) {
      setStatus({ kind: "error", message: failureMessage(error) });
    }
  }

  return (
    <>
      <ModelViewport label="サンプルの住宅モデル" display={display} />
      {status.kind === "preparing" && <p role="status">サンプルを用意しています…</p>}
      {status.kind === "queued" && <p role="status">順番を待っています（前に{status.ahead}件）…</p>}
      {status.kind === "running" && <p role="status">サンプルの形を作っています…</p>}
      {status.kind === "loading_view" && <p role="status">サンプルを読み込んでいます…</p>}
      {status.kind === "done" && (
        <p>
          案{status.view.revision.number}「{status.view.revision.name}」を表示しています。
        </p>
      )}
      {(status.kind === "failed" || status.kind === "stopped") && (
        <p role="alert">
          {status.kind === "failed" ? "サンプルの形を作れませんでした。" : "指示が止められました。"}{" "}
          <button onClick={sendAgain}>もう一度送る</button>
        </p>
      )}
      {status.kind === "error" && (
        <p role="alert">
          {status.message} <button onClick={retry}>再試行</button>
        </p>
      )}
      <p>ドラッグで回転、スクロールで拡大・縮小できます。</p>
    </>
  );
}
