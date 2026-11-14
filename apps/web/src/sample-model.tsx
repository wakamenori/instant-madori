import { useEffect, useState } from "react";
import { ApiError, fetchSampleDisplay } from "./api.ts";
import { ModelViewport } from "./viewer/model-viewport.tsx";
type State =
  { kind: "loading" } | { kind: "ready"; bytes: Uint8Array } | { kind: "failed"; message: string };
export function SampleModel() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void fetchSampleDisplay(controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setState({ kind: "ready", bytes });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            kind: "failed",
            message:
              error instanceof ApiError && error.code === "service_unavailable"
                ? "形状サービスを利用できません。しばらくしてから再試行してください。"
                : error instanceof ApiError && error.code === "network"
                  ? "通信に失敗しました。接続を確認して再試行してください。"
                  : "サンプルの取得に失敗しました。",
          });
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <>
      <ModelViewport
        label="サンプルの住宅モデル"
        display={state.kind === "ready" ? state.bytes : null}
      />
      {state.kind === "loading" && <p role="status">サンプルを読み込んでいます…</p>}
      {state.kind === "failed" && (
        <p role="alert">
          {state.message}{" "}
          <button
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            再試行
          </button>
        </p>
      )}
      <p>ドラッグで回転、スクロールで拡大・縮小できます。</p>
    </>
  );
}
