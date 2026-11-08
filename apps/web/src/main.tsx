import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { workerHealthSchema } from "@madori/contracts";
import initViewer, { check_runtime } from "../../../crates/viewer/pkg/madori_viewer.js";
import "./style.css";

type Connection =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function App() {
  const [connection, setConnection] = useState<Connection>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    async function connect() {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error(`Worker: HTTP ${response.status}`);
      const body: unknown = await response.json();
      workerHealthSchema.parse(body);
      await initViewer();
      if (!check_runtime()) throw new Error("Wasmの初期化を確認できませんでした。");
      if (active) setConnection({ kind: "ready" });
    }
    void connect().catch((error: unknown) => {
      if (active) setConnection({ kind: "error", message: error instanceof Error ? error.message : "接続に失敗しました。" });
    });
    return () => { active = false; };
  }, []);

  return <main>
    <p className="eyebrow">開発環境</p>
    <h1>instant-madori</h1>
    <p>住宅相談サービスの開発用の入口です。</p>
    <p role="status">{connection.kind === "loading" ? "接続を確認しています…" : connection.kind === "ready" ? "Workerへの接続とWasmの初期化を確認しました。" : connection.message}</p>
    <p className="note">住宅の生成・表示、ログイン、保存はこれから実装します。</p>
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
