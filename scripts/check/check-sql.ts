import { glob, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { repositoryRoot } from "../shared/repository.ts";

interface SqlToken {
  text: string;
  index: number;
}

function sqlTokens(sql: string): SqlToken[] {
  return Array.from(
    sql.matchAll(
      /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$\0]+|[^\s]/g,
    ),
    (match) => ({ text: match[0].toLowerCase(), index: match.index }),
  ).filter(({ text }) => !text.startsWith("--") && !text.startsWith("/*"));
}

function writesRequests(sql: string): boolean {
  const tokens = sqlTokens(sql).map(({ text }) => text);
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

function sqlWithSlots(node: ts.StringLiteralLike | ts.TemplateExpression): string {
  return ts.isTemplateExpression(node)
    ? node.head.text + node.templateSpans.map((span) => "\0" + span.literal.text).join("")
    : node.text;
}

const queryHeads = new Set(["select", "values", "with"]);
const bareWord = (token: string) => token.replace(/^\0+|\0+$/g, "");

type Region = "value-source" | "join-filter" | "row-filter";

interface ScanState {
  region: Region;
  depth: number;
}

interface SqlScan {
  nested: "subquery" | "CTE" | undefined;
  slots: { index: number; state: ScanState }[];
}

function scanSql(sql: string, start: ScanState): SqlScan {
  let nested: SqlScan["nested"];
  const slots: SqlScan["slots"] = [];
  let { region, depth } = start;
  for (const { text, index } of sqlTokens(sql)) {
    if (/^['"`[]/.test(text)) continue;
    if (text.includes("\0")) {
      const first = sql.slice(0, index).split("\0").length - 1;
      const count = text.split("\0").length - 1;
      for (let slot = first; slot < first + count; slot++)
        slots.push({ index: slot, state: { region, depth } });
    }
    const word = bareWord(text);
    if (word === "(") depth++;
    else if (word === ")") depth--;
    else if (depth > 0) {
      if (region === "value-source" && queryHeads.has(word)) nested ??= "subquery";
    } else if (depth !== 0) continue;
    else if (word === "with") nested ??= "CTE";
    else if (word === "select" || word === "values") region = "value-source";
    else if (word === "on" && region === "value-source") region = "join-filter";
    else if ((word === "join" || word === ",") && region === "join-filter") region = "value-source";
    else if (/^(?:where|group|having|order|limit|window)$/.test(word)) region = "row-filter";
  }
  return { nested, slots };
}

interface Module {
  path: string;
  file: ts.SourceFile;
}
type ModuleLoader = (path: string) => Module | undefined;

interface Declaration {
  module: Module;
  name: string;
  node: ts.FunctionDeclaration | ts.VariableDeclaration | ts.BindingElement;
}

function boundName(binding: ts.BindingName, name: string): ts.Identifier | undefined {
  if (ts.isIdentifier(binding)) return binding.text === name ? binding : undefined;
  for (const element of binding.elements) {
    if (ts.isBindingElement(element)) {
      const found = boundName(element.name, name);
      if (found) return found;
    }
  }
  return undefined;
}

function declarationIn(
  statements: readonly ts.Statement[],
  module: Module,
  name: string,
): Declaration | undefined {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && statement.name?.text === name) {
      return { module, name, node: statement };
    }
    if (ts.isVariableStatement(statement)) {
      for (const variable of statement.declarationList.declarations) {
        const binding = boundName(variable.name, name);
        if (binding)
          return {
            module,
            name,
            node: ts.isBindingElement(binding.parent) ? binding.parent : variable,
          };
      }
    }
  }
  return undefined;
}

function localOrImportedDeclaration(
  identifier: ts.Identifier,
  module: Module,
  load: ModuleLoader,
): Declaration | undefined {
  const name = identifier.text;
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (
      ts.isFunctionLike(scope) &&
      scope.parameters.some((parameter) => boundName(parameter.name, name))
    )
      return undefined;
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      const found = declarationIn(scope.statements, module, name);
      if (found) return found;
    }
  }
  for (const statement of module.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const bindings = statement.importClause?.namedBindings;
    const element =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.find((candidate) => candidate.name.text === name)
        : undefined;
    if (!element || !statement.moduleSpecifier.text.startsWith(".")) continue;
    const base = join(dirname(module.path), statement.moduleSpecifier.text);
    const target = load(base) ?? load(base + ".ts") ?? load(join(base, "index.ts"));
    return (
      target &&
      declarationIn(target.file.statements, target, (element.propertyName ?? element.name).text)
    );
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

function returnedExpressions(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [body];
  const expressions: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
    else ts.forEachChild(node, visit);
  }
  visit(body);
  return expressions;
}

function assignedValues(variable: ts.VariableDeclaration, module: Module, load: ModuleLoader) {
  const values: ts.Expression[] = [];
  if (variable.initializer) values.push(variable.initializer);
  if (variable.parent.flags & ts.NodeFlags.Const) return values;
  let scope: ts.Node = variable.parent;
  while (!ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  function visit(node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
      ts.isIdentifier(node.left) &&
      localOrImportedDeclaration(node.left, module, load)?.node === variable
    )
      values.push(node.right);
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return values;
}

const valueOperators = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

function nestedOwner(
  expression: ts.Expression,
  module: Module,
  load: ModuleLoader,
  state: ScanState,
) {
  const seenValues = new Set<ts.Node>();
  const seenCalls = new Set<ts.Node>();
  function follow(input: ts.Expression, context: Module, owner: string): string | undefined {
    const node = unwrap(input);
    const children: ts.Expression[] = [];
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      if (scanSql(sqlWithSlots(node), state).nested) return owner;
      if (ts.isTemplateExpression(node))
        children.push(...node.templateSpans.map((span) => span.expression));
    } else if (
      ts.isAwaitExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    )
      children.push(node.expression);
    else if (ts.isConditionalExpression(node)) children.push(node.whenTrue, node.whenFalse);
    else if (ts.isBinaryExpression(node)) {
      if (valueOperators.has(node.operatorToken.kind)) children.push(node.left, node.right);
      else if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) children.push(node.right);
    } else if (ts.isArrayLiteralExpression(node)) children.push(...node.elements);
    else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) children.push(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) children.push(property.name);
        else if (ts.isSpreadAssignment(property)) children.push(property.expression);
      }
    } else if (ts.isCallExpression(node)) {
      children.push(...node.arguments);
      if (ts.isPropertyAccessExpression(node.expression)) children.push(node.expression.expression);
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      children.push(...returnedExpressions(node.body));

    for (const child of children) {
      const found = follow(child, context, owner);
      if (found) return found;
    }
    const call = ts.isCallExpression(node);
    const identifier = call ? node.expression : node;
    if (!ts.isIdentifier(identifier)) return undefined;
    const declaration = localOrImportedDeclaration(identifier, context, load);
    const seen = call ? seenCalls : seenValues;
    if (!declaration || seen.has(declaration.node)) return undefined;
    const declared = declaration.node;
    let values: ts.Expression[];
    if (call) {
      const fn =
        ts.isVariableDeclaration(declared) && declared.initializer
          ? unwrap(declared.initializer)
          : declared;
      if (
        !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
        !fn.body
      )
        return undefined;
      values = returnedExpressions(fn.body);
    } else if (ts.isVariableDeclaration(declared)) {
      values = assignedValues(declared, declaration.module, load);
    } else if (ts.isBindingElement(declared)) {
      let variable: ts.Node = declared;
      while (ts.isBindingElement(variable)) variable = variable.parent.parent;
      if (!ts.isVariableDeclaration(variable) || !variable.initializer) return undefined;
      values = [variable.initializer];
    } else return undefined;
    seen.add(declared);
    for (const value of values) {
      const found = follow(
        value,
        declaration.module,
        `${declaration.name} in ${declaration.module.path}`,
      );
      if (found) return found;
    }
    return undefined;
  }
  return follow(expression, module, "an expression");
}

const nestingMessages = { subquery: "builds its value from a subquery", CTE: "uses a CTE" };
const onceEntryPoints = new Set(["createOnceStatements", "updateOnceStatements"]);
const resultRule =
  "build the whole object in one json_object expression and keep subqueries out of the select list and FROM (see recordStatement in apps/worker/src/storage/requests.ts).";

function lastProperty(object: ts.Expression | undefined, name: string) {
  if (!object) return undefined;
  const node = unwrap(object);
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  let readable = true;
  for (let index = node.properties.length - 1; index >= 0; index--) {
    const property = node.properties[index];
    if (!property) continue;
    if (ts.isSpreadAssignment(property)) readable = false;
    else if (
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      return {
        property,
        value:
          readable && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined,
      };
    }
  }
  return undefined;
}

export function checkSqlSource(
  path: string,
  source: string,
  modules: ReadonlyMap<string, string> = new Map(),
) {
  const violations: string[] = [];
  const root = fileURLToPath(repositoryRoot);
  const sourcePath = relative(root, resolve(root, path));
  const restrictRequestWrites =
    sourcePath.startsWith("apps/worker/src/") &&
    sourcePath !== "apps/worker/src/storage/requests.ts";
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function report(node: ts.Node, message: string) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${path}:${line + 1}:${character + 1}: ${message}`);
  }
  function checkText(text: string, offset: number) {
    for (const match of text.matchAll(/\b(?:changes|total_changes|last_insert_rowid)(?=\s*\()/gi)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset + match.index);
      violations.push(
        `${path}:${line + 1}:${character + 1}: ${match[0].toLowerCase()}() depends on connection state; use row data instead.`,
      );
    }
  }
  const module: Module = { path, file: sourceFile };
  const loaded = new Map<string, Module | undefined>([[path, module]]);
  const load: ModuleLoader = (modulePath) => {
    if (!loaded.has(modulePath)) {
      const text = modules.get(modulePath);
      loaded.set(
        modulePath,
        text === undefined
          ? undefined
          : {
              path: modulePath,
              file: ts.createSourceFile(modulePath, text, ts.ScriptTarget.Latest, true),
            },
      );
    }
    return loaded.get(modulePath);
  };
  function checkResult(call: ts.CallExpression, callee: string) {
    const input = call.arguments[2];
    const result = lastProperty(input, "result");
    const sql = lastProperty(result?.value, "sql")?.value;
    if (!sql || !(ts.isStringLiteralLike(sql) || ts.isTemplateExpression(sql))) {
      report(
        result?.property ?? input ?? call,
        `${callee} needs result: { sql: \`...\` } written inline so check-sql can read its result SQL.`,
      );
      return;
    }
    const { nested, slots } = scanSql(sqlWithSlots(sql), { region: "value-source", depth: 0 });
    if (nested !== undefined) {
      report(sql, `result SQL ${nestingMessages[nested]}; ${resultRule}`);
    }
    for (const { index, state } of slots) {
      if (state.region !== "value-source" && state.depth !== 0) continue;
      const expression = ts.isTemplateExpression(sql)
        ? sql.templateSpans[index]?.expression
        : undefined;
      const owner = expression && nestedOwner(expression, module, load, state);
      if (expression && owner !== undefined) {
        report(
          expression,
          `result SQL interpolates ${owner}, which builds its value from a subquery or CTE; ${resultRule}`,
        );
      }
    }
  }
  if (path.endsWith(".sql")) {
    checkText(source, 0);
  } else {
    const entryPoints = new Map(Array.from(onceEntryPoints, (name) => [name, name]));
    for (const statement of sourceFile.statements) {
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : undefined;
      for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
        const imported = (element.propertyName ?? element.name).text;
        if (onceEntryPoints.has(imported)) entryPoints.set(element.name.text, imported);
      }
    }
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
      const sql =
        ts.isTemplateExpression(node) || ts.isStringLiteralLike(node)
          ? sqlWithSlots(node)
          : undefined;
      if (restrictRequestWrites && sql !== undefined && writesRequests(sql)) {
        report(node, "writes to requests are only allowed in apps/worker/src/storage/requests.ts.");
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? entryPoints.get(node.expression.text)
          : ts.isPropertyAccessExpression(node.expression) &&
              onceEntryPoints.has(node.expression.name.text)
            ? node.expression.name.text
            : undefined;
        if (callee !== undefined) checkResult(node, callee);
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
  const groups: { pattern: string; files: [string, string][] }[] = [];
  for (const pattern of targets) {
    const paths: string[] = [];
    for await (const path of glob(pattern, { cwd: root })) paths.push(path);
    paths.sort();
    const files: [string, string][] = [];
    for (const path of paths) files.push([path, await readFile(join(root, path), "utf8")]);
    groups.push({ pattern, files });
  }
  const sources = new Map(groups.flatMap(({ files }) => files));
  for (const { pattern, files } of groups) {
    if (files.length === 0) violations.push(`${pattern}: no files found under ${root}.`);
    for (const [path, source] of files) violations.push(...checkSqlSource(path, source, sources));
  }
  return { files: sources.size, violations };
}

if (import.meta.main) {
  const { files, violations } = await checkSqlFiles(
    process.argv[2] ?? fileURLToPath(repositoryRoot),
  );
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `SQL connection-state, request-write and result-nesting checks passed: ${files} files.`,
    );
  }
}
