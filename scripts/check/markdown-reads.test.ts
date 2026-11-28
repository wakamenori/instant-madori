import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";

const root = fileURLToPath(repositoryRoot);
const recorder = new URL("./record-markdown-reads.ts", import.meta.url);
const verifier = new URL("./markdown-reads.ts", import.meta.url);

function scratch(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "madori-markdown-reads-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function recorderEnv(record: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `--import=${recorder.href}`,
    MADORI_MARKDOWN_READS: record,
  };
  delete env.MADORI_MARKDOWN_READER;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

void test("records Markdown read by a test and attributes its subprocess reads to the test", (t) => {
  const directory = scratch(t);
  const record = join(directory, "reads.jsonl");
  const entry = join(directory, "reader.test.mjs");
  const outside = join(directory, "outside.md");
  writeFileSync(outside, "outside");
  writeFileSync(
    entry,
    `
    import { execFileSync } from "node:child_process";
    import { copyFileSync, existsSync, openAsBlob, readFileSync } from "node:fs";
    import { test } from "node:test";
    test("read repository files", async () => {
      const blob = await openAsBlob(new URL("README.md", ${JSON.stringify(repositoryRoot.href)}));
      await blob.text();
      copyFileSync("AGENTS.md", ${JSON.stringify(join(directory, "copy.md"))});
      for (const path of ${JSON.stringify([outside, "node_modules/zod/README.md", "third_party/solidcraft/README.md", "package.json"])}) {
        readFileSync(path);
      }
      existsSync("CLAUDE.md");
      execFileSync(process.execPath, ["--input-type=module", "-e",
        'import { readFile } from "node:fs/promises"; await readFile("docs/plan.md");']);
    });
  `,
  );
  const result = spawnSync(process.execPath, ["--test", entry], {
    cwd: root,
    env: recorderEnv(record),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reader = relative(root, entry);
  assert.deepEqual(
    new Set(readFileSync(record, "utf8").trimEnd().split("\n")),
    new Set(
      ["README.md", "AGENTS.md", "docs/plan.md", "third_party/solidcraft/README.md"].map((path) =>
        JSON.stringify({ reader, path }),
      ),
    ),
  );
});

const firstReader = "scripts/check/check.test.ts";
const secondReader = "scripts/check/ci-mode.test.ts";

function verify(record: string, ...listed: string[]) {
  return spawnSync(process.execPath, [fileURLToPath(verifier), record, ...listed], {
    cwd: root,
    encoding: "utf8",
  });
}

void test("verifies recorded docs mode reads and ignores readers of full-check Markdown", (t) => {
  const directory = scratch(t);
  const record = join(directory, "reads.jsonl");
  for (const [name, markdown] of [
    ["docs-reader.mjs", "README.md"],
    ["full-reader.mjs", "third_party/solidcraft/README.md"],
  ] as const) {
    const entry = join(directory, name);
    writeFileSync(entry, `import { readFileSync } from "node:fs"; readFileSync("${markdown}");`);
    const result = spawnSync(process.execPath, [entry], {
      cwd: root,
      env: recorderEnv(record),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const reader = relative(root, join(directory, "docs-reader.mjs"));
  const listed = verify(record, reader);
  assert.equal(listed.status, 0, listed.stderr);
  const unlisted = verify(record);
  assert.equal(unlisted.status, 1, unlisted.stderr);
  assert(unlisted.stderr.includes(`Unlisted Markdown reader ${reader} opened:\n  README.md`));
  assert(!unlisted.stderr.includes("full-reader.mjs"), unlisted.stderr);
});

void test("CI mode selection and Markdown reader verification still work under the preload", (t) => {
  const directory = scratch(t);
  const record = join(directory, "reads.jsonl");
  writeFileSync(record, JSON.stringify({ reader: firstReader, path: "README.md" }) + "\n");
  const env = recorderEnv(join(directory, "cli-reads.jsonl"));
  const ciMode = fileURLToPath(new URL("./ci-mode.ts", import.meta.url));
  const selection = spawnSync(process.execPath, [ciMode], {
    cwd: root,
    env,
    encoding: "utf8",
    input: "docs/plan.md\0",
  });
  assert.equal(selection.status, 0, selection.stderr);
  assert.equal(selection.stdout, "--docs");

  for (const listed of [[firstReader], []]) {
    const args = [fileURLToPath(verifier), record, ...listed];
    const expected = verify(record, ...listed);
    const actual = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
    assert.equal(actual.status, expected.status, actual.stderr);
    assert.equal(actual.stdout, expected.stdout);
    assert.equal(actual.stderr, expected.stderr);
  }
});

void test("reports each unlisted reader and its Markdown paths with a corrected list", (t) => {
  const record = join(scratch(t), "reads.jsonl");
  writeFileSync(
    record,
    ["README.md", "docs/plan.md", "README.md"]
      .map((path) => JSON.stringify({ reader: secondReader, path }) + "\n")
      .join(""),
  );
  const result = verify(record, firstReader);
  assert.equal(result.status, 1, result.stderr);
  assert(
    result.stderr.includes(
      `Unlisted Markdown reader ${secondReader} opened:\n  README.md\n  docs/plan.md\n`,
    ),
  );
  assert(result.stderr.includes(JSON.stringify([firstReader, secondReader], null, 2)));
});

void test("rejects a missing listed test even with reads from a listed test", (t) => {
  const record = join(scratch(t), "reads.jsonl");
  writeFileSync(record, JSON.stringify({ reader: firstReader, path: "README.md" }) + "\n");
  const missingReader = "scripts/check/missing-markdown-reader.test.ts";
  const result = verify(record, firstReader, missingReader);
  assert.equal(result.status, 1, result.stderr);
  assert(result.stderr.includes(`Listed Markdown reader does not exist: ${missingReader}`));
});

void test("rejects an empty or missing record when the list is non-empty", (t) => {
  const directory = scratch(t);
  const empty = join(directory, "empty.jsonl");
  writeFileSync(empty, "");
  for (const record of [empty, join(directory, "missing.jsonl")]) {
    const result = verify(record, firstReader);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No Markdown reads were recorded/u);
  }
});

void test("accepts a record whose readers equal or are a subset of the list", (t) => {
  const record = join(scratch(t), "reads.jsonl");
  writeFileSync(record, JSON.stringify({ reader: firstReader, path: "README.md" }) + "\n");
  for (const listed of [[firstReader], [firstReader, secondReader]]) {
    const result = verify(record, ...listed);
    assert.equal(result.status, 0, result.stderr);
  }
});

void test("rejects a record with unexpected fields", (t) => {
  const record = join(scratch(t), "reads.jsonl");
  writeFileSync(
    record,
    JSON.stringify({ reader: firstReader, path: "README.md", extra: true }) + "\n",
  );
  const result = verify(record, firstReader);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /"code": "unrecognized_keys"/u);
});
