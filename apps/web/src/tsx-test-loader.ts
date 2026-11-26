import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import ts from "typescript";
export async function registerTsx(file: URL) {
  const source = await readFile(file, "utf8");
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
      (_all: string, specifier: string) =>
        `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, file).href : import.meta.resolve(specifier))}`,
    );
  return registerHooks({
    load(url, context, nextLoad) {
      if (url === file.href) {
        return { format: "module", source: js, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
