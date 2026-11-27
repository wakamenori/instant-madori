import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

void test("web sources never build DOM from markup strings", () => {
  for (const entry of readdirSync(import.meta.dirname, { recursive: true, withFileTypes: true })) {
    const file = join(entry.parentPath, entry.name);
    if (!entry.isFile() || !/\.tsx?$/.test(file) || file === import.meta.filename) continue;
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|srcdoc|document\.write/,
      file,
    );
  }
});
