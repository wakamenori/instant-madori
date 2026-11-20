import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

import {
  boundaryTestIgnores,
  typescriptBoundaries,
  typescriptScopes,
  typescriptExtensions,
} from "./scripts/check/boundaries.ts";

const baseRestrictedSyntax = [
  {
    selector:
      "ExportNamedDeclaration[exportKind='value'][source] > ExportSpecifier[exportKind='type']",
    message:
      "Use export type declarations for type re-exports to avoid a runtime module dependency.",
  },
];

function boundaryConfig(name, files, ignores, rows, allowImportMetaUrl = false) {
  const globals = rows
    .filter((row) => row.kind === "globals")
    .flatMap((row) => row.names.map((name) => ({ name, message: row.message })));
  const syntax = rows
    .filter((row) => row.kind === "syntax")
    .flatMap((row) => row.selectors.map((selector) => ({ selector, message: row.message })));
  syntax.push(
    {
      selector: "ImportExpression[source.type!='Literal']",
      message: "Use literal dynamic imports so dependency boundaries can be checked.",
    },
    {
      selector:
        "MemberExpression[object.type='MetaProperty'][object.meta.name='import']:matches([property.name='glob'], [property.value='glob'])",
      message:
        "Use literal imports instead of import.meta.glob so dependency boundaries can be checked.",
    },
    ...(!allowImportMetaUrl
      ? [
          {
            selector:
              "NewExpression[callee.name='URL'][arguments.1.object.type='MetaProperty'][arguments.1.object.meta.name='import']:matches([arguments.1.property.name='url'], [arguments.1.property.value='url'])",
            message:
              "Use literal imports instead of new URL with import.meta.url so dependency boundaries can be checked.",
          },
        ]
      : []),
  );
  syntax.push(
    ...globals.flatMap(({ name, message }) =>
      [
        `TSTypeQuery > Identifier[name='${name}']`,
        `TSTypeQuery TSQualifiedName[left.name=/^(?:globalThis|self)$/u][right.name='${name}']`,
      ].map((selector) => ({ selector, message })),
    ),
  );
  return {
    name,
    files,
    ignores,
    rules: {
      "no-restricted-syntax": ["error", ...baseRestrictedSyntax, ...syntax],
      ...(globals.length
        ? {
            "no-restricted-globals": ["error", { globals, checkGlobalObject: true }],
            "no-restricted-properties": [
              "error",
              ...globals.flatMap(({ name, message }) =>
                ["globalThis", "self"].map((object) => ({ object, property: name, message })),
              ),
            ],
            // ESLint's global rule skips TypeScript type references.
            "@typescript-eslint/no-restricted-types": [
              "error",
              {
                types: Object.fromEntries(
                  globals.flatMap(({ name, message }) =>
                    [name, `globalThis.${name}`, `self.${name}`].map((type) => [type, { message }]),
                  ),
                ),
              },
            ],
          }
        : {}),
    },
  };
}

// Several config objects matching one file replace each other's rule options, so each
// file gets exactly one boundary config: source files every row of their scope, test
// files (an AND of the scope glob and a test glob) only the rows marked for tests.
const boundaryConfigs = Object.entries(typescriptScopes).flatMap(([scope, { files, ignores }]) => {
  const rows = typescriptBoundaries.filter((row) => row.from.includes(scope));
  const testRows = rows.filter((row) => row.appliesToTests);
  // Tests read fixtures through import.meta.url and may cross boundaries anyway.
  return [
    boundaryConfig(`boundaries/${scope}`, files, [...ignores, ...boundaryTestIgnores], rows),
    boundaryConfig(
      `boundaries/${scope}/tests`,
      files.flatMap((file) => boundaryTestIgnores.map((test) => [file, test])),
      ignores,
      testRows,
      true,
    ),
  ];
});

export default defineConfig(
  globalIgnores([
    "third_party/solidcraft/**",
    "node_modules/**",
    "**/dist/**",
    "**/.wrangler/**",
    "target/**",
    ".tools/**",
    ".claude/worktrees/**",
    "crates/viewer/pkg/**",
    "apps/worker/worker-configuration.d.ts",
    "docs/verification/evidence/**",
  ]),
  {
    files: ["*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      `apps/**/*.${typescriptExtensions}`,
      `packages/**/*.${typescriptExtensions}`,
      `scripts/**/*.${typescriptExtensions}`,
      `metrics/**/*.${typescriptExtensions}`,
    ],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-restricted-syntax": ["error", ...baseRestrictedSyntax],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: [`apps/web/src/**/*.${typescriptExtensions}`],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: [`apps/worker/**/*.${typescriptExtensions}`],
    languageOptions: { globals: { self: "readonly" } },
  },
  {
    // The hook runs inside every agent session, and what it prints reaches the session.
    files: [`metrics/hook/**/*.${typescriptExtensions}`],
    ignores: boundaryTestIgnores,
    rules: { "no-console": "error" },
  },
  ...boundaryConfigs,
  prettier,
);
