import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { TestEvent } from "node:test/reporters";
import { z } from "zod";

const recordSchema = z.strictObject({
  id: z.string().min(1),
  outcome: z.enum(["pass", "fail", "skip"]),
});
export type TestResult = z.infer<typeof recordSchema>;
function line(record: TestResult) {
  return JSON.stringify(recordSchema.parse(record)) + "\n";
}

const suites = ["typescript", "rust", "container"] as const;

export async function resetResults(dir: string) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.some((name) => !suites.some((suite) => name === suite + ".jsonl"))) {
    throw new Error(`Results directory contains unrelated files: ${dir}`);
  }
  for (const name of entries) await rm(join(dir, name));
  await rmdir(dir);
  await mkdir(dir, { recursive: true });
}

export function nodeTestFlags(dir: string, suite: "typescript" | "container") {
  return [
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${import.meta.filename}`,
    `--test-reporter-destination=${join(dir, suite + ".jsonl")}`,
  ];
}

export function cargoTestFlags(dir: string, workspaceRoot = process.cwd()) {
  const runner = [
    process.execPath,
    import.meta.filename,
    resolve(dir, "rust.jsonl"),
    realpathSync(workspaceRoot),
  ];
  return [
    "test",
    "--locked",
    "--workspace",
    "--no-fail-fast",
    "--config",
    `target.'cfg(all())'.runner=${JSON.stringify(runner)}`,
  ];
}

type FileState = {
  ids: Map<number, string>;
  seen: Map<string, number>;
  failed: boolean;
  fileFailed: boolean;
};
export default async function* reporter(source: AsyncIterable<TestEvent>) {
  const files = new Map<string, FileState>();
  for await (const event of source) {
    if (
      event.type !== "test:start" &&
      event.type !== "test:pass" &&
      event.type !== "test:fail" &&
      event.type !== "test:summary"
    )
      continue;
    if (!event.data.file) continue;
    const entryFile = event.type === "test:summary" ? event.data.file : event.data.entryFile;
    const file = relative(process.cwd(), entryFile ?? event.data.file);
    const state: FileState = files.get(file) ?? {
      ids: new Map(),
      seen: new Map(),
      failed: false,
      fileFailed: false,
    };
    files.set(file, state);
    if (event.type === "test:summary") {
      state.fileFailed ||= !event.data.success;
      continue;
    }
    const { name, nesting, testId, parentId } = event.data;
    // A process that crashes on import emits a synthetic file test without a summary.
    if (entryFile === undefined && nesting === 0 && resolve(name) === resolve(file)) {
      state.fileFailed ||= event.type === "test:fail";
      continue;
    }
    if (event.type === "test:start") {
      const parent = parentId === undefined ? undefined : state.ids.get(parentId);
      const base = `${nesting > 0 ? (parent ?? file) : file} > ${name}`;
      const n = (state.seen.get(base) ?? 0) + 1;
      state.seen.set(base, n);
      state.ids.set(testId, n === 1 ? base : `${base} #${n}`);
      continue;
    }
    const error = event.type === "test:fail" ? event.data.details.error : undefined;
    const cause = error && "failureType" in error ? error.failureType : undefined;
    if (cause === "parentAlreadyFinished") continue;
    const outcome =
      event.data.todo !== undefined ||
      event.data.skip !== undefined ||
      cause === "cancelledByParent"
        ? "skip"
        : event.type === "test:fail" && cause !== "subtestsFailed"
          ? "fail"
          : "pass";
    state.failed ||= outcome === "fail";
    const id = state.ids.get(testId);
    if (!id) throw new Error(`Missing start for ${file} > ${name}`);
    yield line({ id, outcome });
  }
  for (const [id, state] of files)
    yield line({ id, outcome: state.fileFailed && !state.failed ? "fail" : "pass" });
}

export function rustBinaryId(
  depInfo: string,
  exe: string,
  workspaceRoot: string,
  manifestDir: string,
  pkg: string,
) {
  for (const row of depInfo.split(/\r?\n/u)) {
    const ruleEnd = row.indexOf(": ");
    if (ruleEnd < 0 || row.slice(0, ruleEnd).replaceAll("\\ ", " ") !== exe) continue;
    const root = /^(?:\\ |[^\s])+/u.exec(row.slice(ruleEnd + 2).trimStart())?.[0];
    if (root) {
      const path = resolve(workspaceRoot, root.replaceAll("\\ ", " "));
      return pkg + "/" + relative(manifestDir, path).split(sep).join("/");
    }
  }
  throw new Error(`Missing crate root for executable ${exe} in ${exe}.d`);
}

export function parseLibtest(binary: string, stdout: string, code: number | null): TestResult[] {
  const records: TestResult[] = [];
  const counts = { pass: 0, fail: 0, skip: 0 };
  let inFailures = false;
  for (const row of stdout.split(/\r?\n/u)) {
    const summary =
      /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/u.exec(row);
    if (summary) {
      if (
        counts.pass !== Number(summary[1]) ||
        counts.fail !== Number(summary[2]) ||
        counts.skip !== Number(summary[3])
      ) {
        throw new Error(`libtest summary mismatch for ${binary}: ${row}`);
      }
      return [
        ...records,
        { id: binary, outcome: code !== 0 && counts.fail === 0 ? "fail" : "pass" },
      ];
    }
    if (row === "failures:") inFailures = true;
    if (inFailures) continue;
    const match = /^test (.*) \.\.\. (ok|FAILED|ignored.*)$/u.exec(row);
    if (match) {
      const outcome = match[2] === "ok" ? "pass" : match[2] === "FAILED" ? "fail" : "skip";
      counts[outcome]++;
      records.push({ id: `${binary}::${match[1]}`, outcome });
    }
  }
  return [...records, { id: binary, outcome: "fail" }];
}

export async function readArtifact(dir: string) {
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const suite = suites.find((s) => entry.name === s + ".jsonl");
    if (!suite || !entry.isFile()) throw new Error(`Unexpected artifact entry: ${entry.name}`);
    const path = join(dir, entry.name);
    if ((await stat(path)).size > 5 * 1024 * 1024)
      throw new Error(`Oversized artifact file: ${entry.name}`);
    const contents = await readFile(path, "utf8");
    const rows = contents.split("\n");
    if (rows.at(-1) === "") rows.pop();
    const ids = new Set<string>();
    for (const row of rows) {
      const record = recordSchema.parse(JSON.parse(row));
      if (ids.has(record.id)) throw new Error(`Duplicate id: ${record.id}`);
      ids.add(record.id);
      results.push({ suite, ...record });
    }
  }
  return results;
}

if (import.meta.main) {
  const [destination, workspaceRoot, exe, ...args] = process.argv.slice(2);
  if (!destination || !workspaceRoot || !exe)
    throw new Error("Expected a destination, workspace root and test executable");
  if (basename(dirname(exe)) !== "deps")
    throw new Error(
      `Test executable outside deps is not recorded: ${exe}. Rust doc-tests and example tests run outside deps; move the code into a #[test], or mark a doc-test code block no_run, ignore or text.`,
    );
  const child = spawn(exe, args, { stdio: ["inherit", "pipe", "inherit"] });
  const chunks: Buffer[] = [];
  child.stdout.pipe(process.stdout, { end: false });
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  const pkg = process.env.CARGO_PKG_NAME;
  if (!pkg) throw new Error("Missing CARGO_PKG_NAME");
  const manifestDir = process.env.CARGO_MANIFEST_DIR;
  if (!manifestDir) throw new Error("Missing CARGO_MANIFEST_DIR");
  const binary = rustBinaryId(
    await readFile(exe + ".d", "utf8"),
    exe,
    workspaceRoot,
    manifestDir,
    pkg,
  );
  await appendFile(
    destination,
    parseLibtest(binary, Buffer.concat(chunks).toString(), code).map(line).join(""),
  );
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
}
