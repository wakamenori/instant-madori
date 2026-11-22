import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import { createElement } from "react";
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
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url === import.meta.resolve("./model-viewport.tsx")) {
        return { format: "module", source: js, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  const module = await import("./model-viewport.tsx").finally(() => hooks.deregister());
  const html = renderToStaticMarkup(
    createElement(module.ModelViewport, { display: null, label: "Different model" }),
  );
  assert.match(html, /role="img" aria-label="Different model"/);
  assert.match(html, /<div[^>]*role="img"[^>]*><\/div><p role="status">/);
  assert.match(html, /<button[^>]* disabled=""[^>]*>視点を戻す<\/button>/);
  assert.match(html, /ドラッグで回転、右ドラッグかShift\+ドラッグで移動、ホイールで拡大・縮小/);
});
