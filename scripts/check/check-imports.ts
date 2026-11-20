import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";
import { boundaryTestIgnores, typescriptBoundaries, typescriptScopes } from "./boundaries.ts";

const manifestSchema = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  peerDependencies: z.record(z.string(), z.string()).default({}),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
});

type Reference = {
  specifier: string;
  offset: number;
  usage: "type" | "runtime";
  names: "*" | string[];
  kind: "module" | "types" | "path" | "declaration";
  mode: ts.ResolutionMode;
};
type Resolution = { kind: "file"; path: string } | { kind: "external" } | { kind: "unresolved" };

function references(source: ts.SourceFile, options: ts.CompilerOptions): Reference[] {
  const result: Reference[] = [];
  function add(
    node: ts.StringLiteralLike,
    usage: Reference["usage"],
    names: Reference["names"],
    kind: Reference["kind"] = "module",
    mode = ts.getModeForUsageLocation(source, node, options),
  ) {
    result.push({ specifier: node.text, offset: node.getStart(source), usage, names, kind, mode });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const names =
        bindings && ts.isNamespaceImport(bindings)
          ? "*"
          : [
              ...(clause?.name ? ["default"] : []),
              ...(bindings && ts.isNamedImports(bindings)
                ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
                : []),
            ];
      add(node.moduleSpecifier, clause?.isTypeOnly ? "type" : "runtime", names);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text)
          : "*";
      add(node.moduleSpecifier, node.isTypeOnly ? "type" : "runtime", names);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      let argument = node.arguments[0];
      while (argument && ts.isParenthesizedExpression(argument)) argument = argument.expression;
      if (argument && ts.isStringLiteral(argument))
        add(argument, "runtime", "*", "module", ts.ModuleKind.ESNext);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      let name = node.qualifier;
      while (name && ts.isQualifiedName(name)) name = name.left;
      add(node.argument.literal, "type", name ? [name.text] : "*");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression))
        add(expression, node.isTypeOnly ? "type" : "runtime", "*");
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      add(node.name, "type", "*", "declaration");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [kind, directives] of [
    ["types", source.typeReferenceDirectives],
    ["path", source.referencedFiles],
  ] satisfies [Reference["kind"], readonly ts.FileReference[]][]) {
    for (const directive of directives)
      result.push({
        kind,
        specifier: directive.fileName,
        offset: directive.pos,
        usage: "type",
        names: "*",
        mode: ts.getModeForFileReference(directive, source.impliedNodeFormat),
      });
  }
  return result;
}

function packageName(specifier: string) {
  if (specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("#"))
    return undefined;
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

export function createImportBoundaryChecker(root: string) {
  root = realpathSync.native(root);
  const canonical = (path: string) => realpathSync.native(path).replaceAll("\\", "/");
  const manifests = new Map<string, z.infer<typeof manifestSchema>>();
  const workspaceNames = new Set<string>();
  for (const path of [
    "package.json",
    ...globSync(["apps/*/package.json", "packages/*/package.json"], { cwd: root }),
  ]) {
    const absolute = resolve(root, path);
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(absolute, "utf8")));
    manifests.set(dirname(absolute), manifest);
    if (manifest.name) workspaceNames.add(manifest.name);
  }
  type Project = { path: string; config: ts.ParsedCommandLine; files: Set<string> };
  const projects = new Map<string, Project>();
  const ambientModules = new Map<string, ts.Symbol[]>();
  function project(file: string) {
    const path = ts.findConfigFile(dirname(file), (path) => ts.sys.fileExists(path));
    if (!path) return undefined;
    let entry = projects.get(path);
    if (!entry) {
      const config = ts.getParsedCommandLineOfConfigFile(
        path,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
          },
        },
      );
      if (!config || config.errors.length) throw new Error(`Invalid tsconfig: ${path}`);
      entry = { path, config, files: new Set(config.fileNames.map(canonical)) };
      projects.set(path, entry);
    }
    return entry.files.has(file) ? entry : undefined;
  }
  function declaredExternal(specifier: string, file: string) {
    const name = packageName(specifier);
    if (!name || workspaceNames.has(name)) return false;
    let directory = dirname(file);
    while (true) {
      const manifest = manifests.get(directory);
      if (manifest)
        return [
          manifest.dependencies,
          manifest.devDependencies,
          manifest.peerDependencies,
          manifest.optionalDependencies,
        ].some((dependencies) => Object.hasOwn(dependencies, name));
      const parent = dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  }
  function resolveReference(
    reference: Reference,
    file: ts.SourceFile,
    { path, config }: Project,
  ): Resolution {
    const specifier = reference.specifier.replaceAll("\\", "/").replace(/[?#].*$/u, "");
    // Package imports maps begin with #; a leading # is not an asset fragment.
    const name = reference.specifier.startsWith("#")
      ? (reference.specifier.split("?")[0] ?? reference.specifier)
      : specifier;
    const target =
      reference.kind === "types"
        ? ts.resolveTypeReferenceDirective(
            name,
            file.fileName,
            config.options,
            ts.sys,
            undefined,
            undefined,
            reference.mode,
          ).resolvedTypeReferenceDirective?.resolvedFileName
        : reference.kind === "path"
          ? resolve(dirname(file.fileName), name)
          : ts.resolveModuleName(
              name,
              file.fileName,
              config.options,
              ts.sys,
              undefined,
              undefined,
              reference.mode,
            ).resolvedModule?.resolvedFileName;
    if (target && existsSync(target) && statSync(target).isFile())
      return { kind: "file", path: canonical(target) };
    if ((name.startsWith(".") || isAbsolute(name)) && !/\.[cm]?[jt]sx?$/u.test(name)) {
      const asset = resolve(dirname(file.fileName), name);
      if (existsSync(asset) && statSync(asset).isFile())
        return { kind: "file", path: canonical(asset) };
    }
    if (isBuiltin(name) || declaredExternal(name, file.fileName)) return { kind: "external" };
    if (!name.startsWith(".") && !isAbsolute(name)) {
      let modules = ambientModules.get(path);
      if (!modules) {
        modules = ts
          .createProgram(config.fileNames, config.options)
          .getTypeChecker()
          .getAmbientModules();
        ambientModules.set(path, modules);
      }
      const symbol = modules.find((module) => module.name === JSON.stringify(name));
      const declaration = symbol?.declarations?.[0];
      if (declaration)
        return { kind: "file", path: canonical(declaration.getSourceFile().fileName) };
      if (reference.kind === "declaration" && !ts.isExternalModule(file))
        return { kind: "external" };
    }
    return { kind: "unresolved" };
  }
  return function checkFile(filename: string) {
    const file = canonical(resolve(root, filename));
    const from = relative(root, file).replaceAll("\\", "/");
    const entry = project(file);
    if (!entry)
      return [
        {
          file: from,
          line: 1,
          column: 1,
          boundaryId: "outside-tsconfig",
          message: "No tsconfig.json includes this file.",
        },
      ];
    const scopes = Object.entries(typescriptScopes)
      .filter(
        ([, scope]) =>
          scope.files.some((pattern) => matchesGlob(from, pattern)) &&
          !scope.ignores.some((pattern) => matchesGlob(from, pattern)),
      )
      .map(([name]) => name);
    const isTest = boundaryTestIgnores.some((pattern) => matchesGlob(from, pattern));
    const rows = typescriptBoundaries.filter(
      (row) =>
        row.kind === "imports" &&
        row.from.some((scope) => scopes.includes(scope)) &&
        (!isTest || row.appliesToTests),
    );
    const { config } = entry;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      {
        languageVersion: ts.ScriptTarget.Latest,
        impliedNodeFormat: ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, config.options),
      },
      true,
    );
    const diagnostics: {
      file: string;
      line: number;
      column: number;
      boundaryId: string;
      message: string;
    }[] = [];
    for (const reference of references(source, config.options)) {
      const location = source.getLineAndCharacterOfPosition(reference.offset);
      function report(boundaryId: string, message: string) {
        diagnostics.push({
          file: from,
          line: location.line + 1,
          column: location.character + 1,
          boundaryId,
          message,
        });
      }
      const resolved = resolveReference(reference, source, entry);
      if (resolved.kind === "unresolved") {
        report("unresolved-import", `Cannot resolve ${JSON.stringify(reference.specifier)}.`);
        continue;
      }
      if (resolved.kind === "external") continue;
      const target = relative(root, resolved.path).replaceAll("\\", "/");
      for (const row of rows) {
        if (row.kind !== "imports" || !row.targets.some((pattern) => matchesGlob(target, pattern)))
          continue;
        if (row.exceptTargets?.some((pattern) => matchesGlob(target, pattern))) continue;
        if (row.publicEntry?.file === target && row.publicEntry.specifier === reference.specifier)
          continue;
        if (row.allowTypeImports && reference.usage === "type") continue;
        const namePattern = row.importNamePattern
          ? new RegExp(row.importNamePattern, "u")
          : undefined;
        if (
          namePattern &&
          reference.names !== "*" &&
          !reference.names.some((name) => namePattern.test(name))
        )
          continue;
        report(row.id, row.message);
      }
    }
    return diagnostics;
  };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const paths = process.argv.slice(2);
  const files = paths.length
    ? paths.filter((path) => /\.[cm]?tsx?$/u.test(path) && existsSync(resolve(root, path)))
    : [
        ...new Set(
          globSync(
            [
              ...Object.values(typescriptScopes).flatMap((scope) => scope.files),
              "scripts/**/*.{ts,tsx,mts,cts}",
            ],
            {
              cwd: root,
              exclude: [
                "**/node_modules/**",
                "**/dist/**",
                "**/.wrangler/**",
                "apps/worker/worker-configuration.d.ts",
              ],
            },
          ),
        ),
      ];
  const checkFile = createImportBoundaryChecker(root);
  const diagnostics = files.flatMap(checkFile);
  for (const diagnostic of diagnostics)
    console.error(
      `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: [${diagnostic.boundaryId}] ${diagnostic.message}`,
    );
  if (diagnostics.length) process.exitCode = 1;
  else console.log(`Resolved import boundary check passed: ${files.length} files.`);
}
