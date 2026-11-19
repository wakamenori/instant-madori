import { glob, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { repositoryRoot } from "../shared/repository.ts";

function writesRequests(sql: string): boolean {
  const tokens = Array.from(
    sql.matchAll(
      /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$\0]+|[^\s]/g,
    ),
    (match) => match[0].toLowerCase(),
  ).filter((token) => !token.startsWith("--") && !token.startsWith("/*"));

  for (const [index, raw] of tokens.entries()) {
    const token = raw.replace(/^\0+|\0+$/g, "");
    let target = index + 1;
    while (/^\0+$/.test(tokens[target] ?? "") && tokens[target + 1] !== ".") target++;
    if ((token === "insert" || token === "update") && tokens[target] === "or") target += 2;
    if (token === "insert" || token === "replace") {
      if (tokens[target] !== "into") continue;
      target++;
    } else if (token === "delete") {
      if (tokens[target] !== "from") continue;
      target++;
    } else if (token !== "update") {
      continue;
    }
    if (tokens[target + 1] === ".") target += 2;
    if (/^(?:requests|"requests"|'requests'|`requests`|\[requests\])$/.test(tokens[target] ?? "")) {
      return true;
    }
  }
  return false;
}

export function checkSqlSource(path: string, source: string) {
  const violations: string[] = [];
  const root = fileURLToPath(repositoryRoot);
  const sourcePath = relative(root, resolve(root, path));
  const restrictRequestWrites =
    sourcePath.startsWith("apps/worker/src/") &&
    sourcePath !== "apps/worker/src/storage/requests.ts";
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function checkText(text: string, offset: number) {
    for (const match of text.matchAll(/\b(?:changes|total_changes|last_insert_rowid)(?=\s*\()/gi)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset + match.index);
      violations.push(
        `${path}:${line + 1}:${character + 1}: ${match[0].toLowerCase()}() depends on connection state; use row data instead.`,
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
      const sql = ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map((span) => "\0" + span.literal.text).join("")
        : ts.isStringLiteralLike(node)
          ? node.text
          : undefined;
      if (restrictRequestWrites && sql !== undefined && writesRequests(sql)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push(
          `${path}:${line + 1}:${character + 1}: writes to requests are only allowed in apps/worker/src/storage/requests.ts.`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return violations;
}

const targets = ["apps/worker/src/**/*.ts", "apps/worker/migrations/*.sql"];

export async function checkSqlFiles(
  root: string,
): Promise<{ files: number; violations: string[] }> {
  const violations: string[] = [];
  let files = 0;
  for (const pattern of targets) {
    const paths: string[] = [];
    for await (const path of glob(pattern, { cwd: root })) paths.push(path);
    paths.sort();
    if (paths.length === 0) violations.push(`${pattern}: no files found under ${root}.`);
    for (const path of paths) {
      violations.push(...checkSqlSource(path, await readFile(join(root, path), "utf8")));
      files++;
    }
  }
  return { files, violations };
}

if (import.meta.main) {
  const { files, violations } = await checkSqlFiles(
    process.argv[2] ?? fileURLToPath(repositoryRoot),
  );
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`SQL connection-state and request-write checks passed: ${files} files.`);
  }
}
