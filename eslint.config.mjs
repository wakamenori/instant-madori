import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

const internalGeometryImport = {
  name: "@madori/contracts/geometry-internal",
  message: "Use public @madori/contracts exports in web.",
};

export default defineConfig(
  globalIgnores([
    "third_party/solidcraft/**",
    "node_modules/**",
    "**/dist/**",
    "**/.wrangler/**",
    "target/**",
    ".tools/**",
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
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts", "scripts/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-imports": [
        "error",
        {
          paths: [internalGeometryImport],
          patterns: [
            {
              group: ["**/crates/viewer/pkg/*"],
              message: "Import viewer bindings through viewer/wasm.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/viewer/wasm.ts", "apps/web/src/viewer/*.test.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [internalGeometryImport] }] },
  },
  prettier,
);
