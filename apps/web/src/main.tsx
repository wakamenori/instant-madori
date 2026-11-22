import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./style.css";
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <main>
        <p className="eyebrow">開発環境</p>
        <App />
      </main>
    </StrictMode>,
  );
