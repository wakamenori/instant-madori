import { glob, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { repositoryRoot } from "../shared/repository.ts";

export function checkSqlSource(path: string, source: string) {
  const violations: string[] = [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function checkText(text: string, offset: number) {
    for (const match of text.matchAll(/\bchanges\s*\(/gi)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset + match.index);
      violations.push(
        `${path}:${line + 1}:${character + 1}: changes() depends on connection state; use row data instead.`,
      );
    }
  }
  if (path.endsWith(".sql")) {
    checkText(source, 0);
  } else {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      source,
    );
    function visit(node: ts.Node) {
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
        const start = node.getStart(sourceFile);
        scanner.setTextPos(start);
        scanner.scan();
        if (
          node.kind === ts.SyntaxKind.TemplateMiddle ||
          node.kind === ts.SyntaxKind.TemplateTail
        ) {
          scanner.reScanTemplateToken(false);
        }
        checkText(scanner.getTokenText(), start);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return violations;
}

if (import.meta.main) {
  const violations: string[] = [];
  let checked = 0;
  for await (const path of glob(["apps/worker/src/**/*.ts", "apps/worker/migrations/*.sql"], {
    cwd: fileURLToPath(repositoryRoot),
  })) {
    const source = await readFile(new URL(path, repositoryRoot), "utf8");
    violations.push(...checkSqlSource(path, source));
    checked++;
  }
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`SQL connection-state check passed: ${checked} files.`);
  }
}
