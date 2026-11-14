import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";
void test("web imports public contracts and viewer bindings through their boundaries", async () => {
  const eslint = new ESLint();
  for (const filePath of ["apps/web/src/api.ts", "apps/web/src/viewer/viewport-session.test.ts"]) {
    const results = await eslint.lintText(
      'import { geometryInternal } from "@madori/contracts/geometry-internal"; void geometryInternal;',
      { filePath },
    );
    assert(
      results.some((result) =>
        result.messages.some((message) => message.ruleId === "no-restricted-imports"),
      ),
    );
  }
  const results = await eslint.lintText(
    'import { Viewer } from "../../../../crates/viewer/pkg/madori_viewer.js"; void Viewer;',
    { filePath: "apps/web/src/viewer/viewport-session.ts" },
  );
  assert(
    results.some((result) =>
      result.messages.some((message) => message.ruleId === "no-restricted-imports"),
    ),
  );
});
