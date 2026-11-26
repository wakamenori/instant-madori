import { registerTsx } from "../tsx-test-loader.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
void test("viewport uses the caller's label and exposes status outside the image", async () => {
  const hooks = await registerTsx(new URL("./model-viewport.tsx", import.meta.url));
  const module = await import("./model-viewport.tsx").finally(() => hooks.deregister());
  const html = renderToStaticMarkup(
    createElement(module.ModelViewport, { display: null, label: "Different model" }),
  );
  assert.match(html, /role="img" aria-label="Different model"/);
  assert.match(html, /<div[^>]*role="img"[^>]*><\/div><p role="status">/);
  assert.match(html, /<button[^>]* disabled=""[^>]*>視点を戻す<\/button>/);
  assert.match(html, /ドラッグで回転、右ドラッグかShift\+ドラッグで移動、ホイールで拡大・縮小/);
});
