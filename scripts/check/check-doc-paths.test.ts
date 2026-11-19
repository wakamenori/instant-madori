import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkDocumentPaths } from "./check-doc-paths.ts";

function repository(t: TestContext, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "madori-doc-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [path, content] of Object.entries({
    "README.md": "",
    "AGENTS.md": "",
    "docs/plan.md": "",
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

for (const directory of [
  "apps",
  "crates",
  "packages",
  "scripts",
  "docs",
  "third_party",
  ".github",
]) {
  void test(`checks existing and missing code paths under ${directory}`, (t) => {
    const root = repository(t, {
      "README.md": `Intro\n  \`${directory}/present/file.ts ${directory}/present ${directory}/present/\`\n  \`${directory}/missing.ts\``,
      [`${directory}/present/file.ts`]: "",
    });
    assert.deepEqual(checkDocumentPaths(root, []), {
      references: 4,
      violations: [`README.md:3:4: ${directory}/missing.ts does not exist.`],
    });
  });
}

void test("resolves links relative to each document and retains written targets", (t) => {
  const root = repository(t, {
    "README.md":
      '[x](plan.md)\n[t](docs/plan.md "Plan")\n![i](docs/picture.png)\n[r]: docs/plan.md\n[space](<docs/with space.md>)\n[encoded](docs/with%20space.md)\n[a](#anchor) [h](docs/plan.md#heading)\n[web](https://example.com/x) [mail](mailto:x@example.com)\n[root](/docs/plan.md)\n[query](docs/plan.md?raw=true)\n[network](//example.com/file)\n[bad](docs/bad%ZZ.md)\n[bad-ref]: docs/no.md',
    "docs/plan.md":
      "[v](verification/x.md)\n[r](../README.md)\n[m](verification/missing.md)\n[home](.) [home](./)\n[empty](<>)",
    "docs/verification/x.md": "",
    "docs/picture.png": "",
    "docs/with space.md": "",
  });
  assert.deepEqual(checkDocumentPaths(root, []), {
    references: 16,
    violations: [
      "README.md:1:5: plan.md does not exist.",
      "README.md:12:7: docs/bad%ZZ.md does not exist.",
      "README.md:13:12: docs/no.md does not exist.",
      "docs/plan.md:3:5: verification/missing.md does not exist (docs/verification/missing.md).",
    ],
  });
});

void test("ignores fragments, bare names, placeholders, globs and URLs in code", (t) => {
  const root = repository(t, {
    "README.md":
      "`storage/d1 api/app.ts geometry/ compose.ts mise.toml scripts/<name>.ts issue-<番号>/ apps/*/tests/**/*.test.ts apps/{web,worker} scripts/[name].ts scripts/file?.ts https://github.com/x/scripts/y`",
  });
  assert.deepEqual(checkDocumentPaths(root, []), { references: 0, violations: [] });
});

void test("allows only an exact planned path", (t) => {
  const root = repository(t, { "docs/plan.md": "`scripts/measure/`" });
  assert.deepEqual(checkDocumentPaths(root, ["scripts/measure/"]), {
    references: 1,
    violations: [],
  });
  assert.deepEqual(checkDocumentPaths(root, []).violations, [
    "docs/plan.md:1:2: scripts/measure/ does not exist.",
  ]);
  assert.deepEqual(checkDocumentPaths(root, ["scripts/measure"]).violations, [
    "docs/plan.md:1:2: scripts/measure/ does not exist.",
    "scripts/check/check-doc-paths.ts: planned path scripts/measure is not mentioned in README.md, AGENTS.md or docs/plan.md; remove it from plannedPaths.",
  ]);
});

void test("reports planned paths that now exist or have no reference last", (t) => {
  const root = repository(t, { "README.md": "`docs/plan.md`\n`docs/missing.md`" });
  assert.deepEqual(checkDocumentPaths(root, ["docs/plan.md", "scripts/unused/"]).violations, [
    "README.md:2:2: docs/missing.md does not exist.",
    "scripts/check/check-doc-paths.ts: planned path docs/plan.md exists now; remove it from plannedPaths.",
    "scripts/check/check-doc-paths.ts: planned path scripts/unused/ is not mentioned in README.md, AGENTS.md or docs/plan.md; remove it from plannedPaths.",
  ]);
});

void test("requires a directory for a trailing slash and checks case exactly", (t) => {
  const root = repository(t, {
    "README.md":
      "`scripts/check/check.ts/`\n`scripts/Check/check.ts`\n[s](scripts/check/check.ts/)",
    "scripts/check/check.ts": "",
  });
  assert.deepEqual(checkDocumentPaths(root, []).violations, [
    "README.md:1:2: scripts/check/check.ts/ is not a directory.",
    "README.md:2:2: scripts/Check/check.ts does not exist.",
    "README.md:3:5: scripts/check/check.ts/ is not a directory.",
  ]);
});

void test("strips line references and normalizes code paths", (t) => {
  const root = repository(t, {
    "README.md": "`docs/plan.md:12 docs/plan.md:12-14 docs/../docs/plan.md`\n`docs/missing.md:3`",
  });
  assert.deepEqual(checkDocumentPaths(root, []), {
    references: 4,
    violations: ["README.md:2:2: docs/missing.md:3 does not exist (docs/missing.md)."],
  });
});

void test("scans fenced code tokens without interpreting links", (t) => {
  const root = repository(t, {
    "README.md": [
      "```sh",
      "node scripts/check/missing.ts",
      "[x](missing.md)",
      "```",
      "~~~",
      "[x](missing.md)",
      "~~~",
      "`[x](missing.md)`",
      "`node scripts/check/other.ts --flag`",
    ].join("\n"),
  });
  assert.deepEqual(checkDocumentPaths(root, []), {
    references: 2,
    violations: [
      "README.md:2:6: scripts/check/missing.ts does not exist.",
      "README.md:9:7: scripts/check/other.ts does not exist.",
    ],
  });
});

void test("matches exact backtick runs and leaves unmatched runs literal", (t) => {
  const root = repository(t, {
    "README.md": [
      "``node ` scripts/a.ts `` [x](docs/a.md)",
      "`unmatched [x](docs/b.md)",
      "``scripts/not-closed.ts`",
      "😀 `[x](docs/hidden.md)` [x](docs/c.md)",
    ].join("\n"),
  });
  assert.deepEqual(checkDocumentPaths(root, []).violations, [
    "README.md:1:10: scripts/a.ts does not exist.",
    "README.md:1:30: docs/a.md does not exist.",
    "README.md:2:16: docs/b.md does not exist.",
    "README.md:4:30: docs/c.md does not exist.",
  ]);
});

void test("keeps unclosed fences open and requires a matching closing fence", (t) => {
  const root = repository(t, {
    "README.md": [
      "  ````sh",
      "```",
      "~~~~",
      "```` trailing",
      "[x](missing.md)",
      "`````",
      "[x](docs/missing.md)",
      "~~~",
      "[x](missing.md)",
      " scripts/fenced.ts",
    ].join("\n"),
  });
  assert.deepEqual(checkDocumentPaths(root, []).violations, [
    "README.md:7:5: docs/missing.md does not exist.",
    "README.md:10:2: scripts/fenced.ts does not exist.",
  ]);
});

void test("allows Git-ignored local files and directory-only generated paths", (t) => {
  const root = repository(t, {
    ".gitignore": ".dev.vars\n/crates/viewer/pkg/\n",
    "README.md":
      "`apps/worker/.dev.vars crates/viewer/pkg crates/viewer/pkg/`\n`apps/worker/missing.ts`",
  });
  assert.deepEqual(checkDocumentPaths(root, []), {
    references: 4,
    violations: ["README.md:2:2: apps/worker/missing.ts does not exist."],
  });
});

void test("reports paths outside the repository without Git-ignore errors", (t) => {
  const root = repository(t, { "docs/plan.md": "[o](../../outside.md)\n`docs/../../outside.md`" });
  assert.deepEqual(checkDocumentPaths(root, []).violations, [
    "docs/plan.md:1:5: ../../outside.md points outside the repository.",
    "docs/plan.md:2:2: docs/../../outside.md points outside the repository.",
  ]);
});

void test("reports every occurrence in document and source order", (t) => {
  const root = repository(t, {
    "docs/plan.md": "`docs/p.md`",
    "AGENTS.md": "`docs/a.md`",
    "README.md": "[x](docs/r.md) `docs/r.md` [x](docs/r.md)",
  });
  assert.deepEqual(checkDocumentPaths(root, []).violations, [
    "README.md:1:5: docs/r.md does not exist.",
    "README.md:1:17: docs/r.md does not exist.",
    "README.md:1:32: docs/r.md does not exist.",
    "AGENTS.md:1:2: docs/a.md does not exist.",
    "docs/plan.md:1:2: docs/p.md does not exist.",
  ]);
});

void test("follows symlinks when checking the directory requirement", (t) => {
  const root = repository(t, {
    "README.md": "`docs/file-link/ docs/directory-link/`",
    "docs/file.md": "",
  });
  symlinkSync("file.md", join(root, "docs/file-link"));
  symlinkSync(".", join(root, "docs/directory-link"));
  assert.deepEqual(checkDocumentPaths(root, []).violations, [
    "README.md:1:2: docs/file-link/ is not a directory.",
  ]);
});
