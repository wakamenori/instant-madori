import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
void test("viewport uses the caller's label and exposes status outside the image", async () => {
  const source = await readFile(new URL("./model-viewport.tsx", import.meta.url), "utf8");
  const js = ts
    .transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replace(
      /from "([^"]+)"/g,
      (_all: string, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
    );
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  )) as { ModelViewport: ComponentType<{ display: null; label: string }> };
  const html = renderToStaticMarkup(
    createElement(module.ModelViewport, { display: null, label: "Different model" }),
  );
  assert.match(html, /role="img" aria-label="Different model"/);
  assert.match(html, /<div[^>]*role="img"[^>]*><\/div><p role="status">/);
});
