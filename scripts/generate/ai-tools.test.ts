import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { repositoryRoot } from "../shared/repository.ts";
import { renderAiTools } from "./ai-tools.ts";
void test("tracked tools match the bounded Rust inputs", async () => {
  const directory = new URL("packages/contracts/src/generated/", repositoryRoot);
  const bounded: unknown = JSON.parse(
    await readFile(new URL("ai-tools.schema.json", directory), "utf8"),
  );
  assert.equal(await readFile(new URL("ai-tools.ts", directory), "utf8"), renderAiTools(bounded));
});
void test("a permissive Zod fallback fails generation", () => {
  assert.throws(
    () => renderAiTools([{ name: "unknown", input: { description: "An unknown schema" } }]),
    /z.any/,
  );
});
