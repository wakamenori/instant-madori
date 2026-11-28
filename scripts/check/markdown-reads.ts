import fs from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { repositoryRoot } from "../shared/repository.ts";
import { checkModeFor } from "./ci-mode.ts";

const root = fileURLToPath(repositoryRoot);
const recordSchema = z.strictObject({
  reader: z.string().min(1),
  path: z.string().min(1),
});

function readRecords(record: string): z.infer<typeof recordSchema>[] {
  let contents: string;
  try {
    contents = fs.readFileSync(record, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => recordSchema.parse(JSON.parse(line)));
}

function verifyReaders(record: string, listed: string[]): boolean {
  const known = new Set(listed);
  const missing = listed.filter((reader) => !fs.existsSync(resolve(root, reader)));
  for (const reader of missing) console.error(`Listed Markdown reader does not exist: ${reader}`);

  const reads = readRecords(record).filter(({ path }) => checkModeFor([path]) === "docs");
  if (listed.length > 0 && reads.length === 0) {
    console.error("No Markdown reads were recorded. Check the recorder and the listed tests.");
    return false;
  }
  const unlisted = new Map<string, Set<string>>();
  for (const { reader, path } of reads) {
    if (known.has(reader)) continue;
    const paths = unlisted.get(reader) ?? new Set<string>();
    paths.add(path);
    unlisted.set(reader, paths);
  }
  if (unlisted.size > 0) {
    for (const [reader, paths] of [...unlisted].sort(([a], [b]) => a.localeCompare(b))) {
      console.error(
        `Unlisted Markdown reader ${reader} opened:\n  ${[...paths].sort().join("\n  ")}`,
      );
    }
    const corrected = [...known, ...unlisted.keys()]
      .filter((reader) => !missing.includes(reader))
      .sort();
    console.error(
      `Update markdownReaderTests in scripts/check/check.ts to:\n${JSON.stringify(corrected, null, 2)}`,
    );
  }
  return missing.length === 0 && unlisted.size === 0;
}

if (import.meta.main) {
  const [record, ...listed] = process.argv.slice(2);
  if (!record) throw new Error("Usage: node scripts/check/markdown-reads.ts <record> <listed...>");
  if (!verifyReaders(record, listed)) process.exitCode = 1;
}
