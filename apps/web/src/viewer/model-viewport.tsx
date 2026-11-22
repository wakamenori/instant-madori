import { useEffect, useRef, useState } from "react";
import { ViewerFailure, ViewerErrorCode } from "./wasm.ts";
import { ViewportSession } from "./viewport-session.ts";
type State = { kind: "opening" } | { kind: "ready" } | { kind: "failed"; message: string };
function failureMessage(error: unknown): string {
  if (error instanceof ViewerFailure) {
    const code = error.code;
    console.error(error.detail);
    error.free();
    switch (code) {
      case ViewerErrorCode.WebGpuUnavailable:
      case ViewerErrorCode.AdapterUnavailable:
        return "WebGPUを利用できるブラウザで開いてください。";
      case ViewerErrorCode.DisplayInvalid:
        return "表示データを読み込めませんでした。";
      case ViewerErrorCode.DeviceLost:
        return "描画への接続が失われました。ページを再読み込みしてください。";
      case ViewerErrorCode.DeviceUnavailable:
      case ViewerErrorCode.SurfaceUnavailable:
        return "3D表示を開始できませんでした。";
    }
  }
  console.error(error);
  return "3D表示でエラーが発生しました。";
}
export function ModelViewport({ display, label }: { display: Uint8Array | null; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<ViewportSession | null>(null);
  const [state, setState] = useState<State>({ kind: "opening" });
  useEffect(() => {
    if (!host.current) return;
    const controller = new AbortController();
    let owned: ViewportSession | undefined;
    void ViewportSession.open(host.current, controller.signal, (error) => {
      if (controller.signal.aborted) {
        if (error instanceof ViewerFailure) error.free();
      } else setState({ kind: "failed", message: failureMessage(error) });
    })
      .then((opened) => {
        if (controller.signal.aborted || opened.disposed) {
          opened.dispose();
          return;
        }
        owned = opened;
        session.current = opened;
        setState({ kind: "ready" });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: "failed", message: failureMessage(error) });
      });
    return () => {
      controller.abort();
      owned?.dispose();
      if (session.current === owned) session.current = null;
    };
  }, []);
  useEffect(() => {
    if (state.kind === "ready" && display) session.current?.show(display);
  }, [display, state.kind]);
  return (
    <>
      <div className="viewport">
        <div className="viewport-canvas" role="img" aria-label={label} ref={host} />
        {state.kind !== "ready" && (
          <p role={state.kind === "failed" ? "alert" : "status"}>
            {state.kind === "opening" ? "3D表示を準備しています…" : state.message}
          </p>
        )}
        {state.kind !== "failed" && (
          <button
            type="button"
            className="viewport-reset"
            disabled={state.kind !== "ready" || !display}
            onClick={() => session.current?.resetView()}
          >
            視点を戻す
          </button>
        )}
      </div>
      {state.kind !== "failed" && (
        <p className="note">
          ドラッグで回転、右ドラッグかShift+ドラッグで移動、ホイールで拡大・縮小
        </p>
      )}
    </>
  );
}
