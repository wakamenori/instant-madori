import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SampleModel } from "./sample-model.tsx";
import "./style.css";
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <main>
        <p className="eyebrow">開発環境</p>
        <h1>instant-madori</h1>
        <SampleModel />
      </main>
    </StrictMode>,
  );
