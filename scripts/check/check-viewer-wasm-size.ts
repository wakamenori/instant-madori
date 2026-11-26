import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from "node:zlib";
import { z } from "zod";
import { repositoryRoot } from "../shared/repository.ts";

const encoders = [
  { key: "raw", label: "raw", limited: true, size: (input: Buffer) => input.length },
  {
    key: "gzip",
    label: "gzip -9",
    limited: true,
    size: (input: Buffer) => gzipSync(input, { level: 9 }).length,
  },
  {
    key: "brotli",
    label: "brotli q11",
    limited: false,
    size: (input: Buffer) =>
      brotliCompressSync(input, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
        },
      }).length,
  },
  {
    key: "zstd",
    label: "zstd -3",
    limited: false,
    size: (input: Buffer) =>
      zstdCompressSync(input, {
        params: {
          [constants.ZSTD_c_compressionLevel]: 3,
        },
      }).length,
  },
] as const;
const keys = encoders.filter((e) => e.limited).map((e) => e.key);
const sizes = z.record(z.enum(keys), z.int().positive());
const entry = z.strictObject({ limits: sizes, measured: sizes, reason: z.string().trim().min(20) });
const ledger = z
  .strictObject({ entries: z.array(entry).min(1) })
  .superRefine(({ entries }, ctx) => {
    const reasons = new Set<string>();
    for (const [i, current] of entries.entries()) {
      for (const key of keys) {
        if (current.measured[key] > current.limits[key])
          ctx.addIssue({
            code: "custom",
            path: ["entries", i, "measured", key],
            message: "Measured size exceeds its limit",
          });
      }
      if (i && isDeepStrictEqual(current.limits, entries[i - 1]?.limits))
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "limits"],
          message: "Change at least one limit",
        });
      if (reasons.has(current.reason))
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "reason"],
          message: "Use a new reason",
        });
      reasons.add(current.reason);
    }
  });

function parseLedger(source: string) {
  const result = ledger.safeParse(JSON.parse(source));
  if (!result.success)
    throw new Error(
      result.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("\n"),
    );
  return result.data.entries;
}

function history(path: string, working: string) {
  const cwd = dirname(resolve(path));
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(run.stderr.trim() || "git " + args[0] + " failed");
    return run.stdout.trimEnd();
  };
  try {
    if (git("rev-parse", "--is-inside-work-tree") !== "true")
      return "History skipped: outside a git work tree.";
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("fatal: not a git repository"))
      return "History skipped: outside a git work tree.";
    throw error;
  }
  let base: string;
  try {
    base = git("merge-base", "HEAD", "origin/main");
  } catch (error) {
    throw new Error("Cannot resolve the merge base. Fetch origin/main. " + String(error), {
      cause: error,
    });
  }
  const name = basename(path);
  if (!git("--literal-pathspecs", "ls-tree", "-z", base, "--", name))
    return "No base ledger at " + base + ".";
  const source = git("show", base + ":./" + name);
  // Compare the original JSON so trimming reasons does not hide edits to earlier entries.
  const original = z.object({ entries: z.array(z.unknown()) });
  const baseEntries = original.parse(JSON.parse(source)).entries;
  if (
    !isDeepStrictEqual(
      baseEntries,
      original.parse(JSON.parse(working)).entries.slice(0, baseEntries.length),
    )
  ) {
    throw new Error("Ledger history changed. Append a new entry instead of editing earlier ones.");
  }
  return "History matches " + base + ".";
}

function main() {
  const root = fileURLToPath(repositoryRoot);
  const wasm = process.argv[2] ?? resolve(root, "crates/viewer/pkg/madori_viewer_bg.wasm");
  const path = process.argv[3] ?? resolve(root, "scripts/check/check-viewer-wasm-size.json");
  let subject = wasm;
  try {
    if (process.argv.length > 4)
      throw new Error("Usage: node scripts/check/check-viewer-wasm-size.ts [<wasm> [<ledger>]]");
    const versions = process.versions;
    console.log(
      `[wasm-size] ${relative(process.cwd(), wasm)} (Node ${process.version}, zlib ${versions.zlib}, brotli ${versions.brotli}, zstd ${versions.zstd})`,
    );
    let input: Buffer;
    try {
      input = readFileSync(wasm);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new Error("Run pnpm setup first (or pnpm check --full).", { cause: error });
      throw error;
    }
    if (!input.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
      throw new Error("Expected Wasm magic and version 1.");
    subject = path;
    const source = readFileSync(path, "utf8");
    const entries = parseLedger(source);
    const current = entries.at(-1);
    if (!current) throw new Error("Empty ledger");
    console.log("| encoding | size (B) | limit (B) | headroom | since limit set |");
    console.log("| --- | ---: | ---: | ---: | ---: |");
    const number = (value: number) => value.toLocaleString("en-US");
    const exceeded: string[] = [];
    const measured: Record<string, number> = {};
    const limits: Record<string, number> = {};
    for (const encoder of encoders) {
      const size = encoder.size(input);
      const row = [encoder.label, number(size)];
      if (encoder.limited) {
        const limit = current.limits[encoder.key];
        const room = limit - size;
        const delta = size - current.measured[encoder.key];
        row.push(
          number(limit),
          `${number(room)} (${((100 * room) / size).toFixed(1)}%)`,
          (delta >= 0 ? "+" : "") + number(delta),
        );
        if (room < 0)
          exceeded.push(
            `${encoder.label}: ${number(size)} B exceeds ${number(limit)} B by ${number(-room)} B.`,
          );
        measured[encoder.key] = size;
        limits[encoder.key] = Math.ceil((size * 105) / 100000) * 1000;
      } else row.push("-", "-", "-");
      console.log("| " + row.join(" | ") + " |");
    }
    console.log(
      `[wasm-size] Limits from entry ${entries.length} of ${relative(process.cwd(), path)}: ${current.reason}`,
    );
    if (exceeded.length) {
      for (const message of exceeded) console.error("[wasm-size] " + message);
      console.error(
        `[wasm-size] Shrink the Wasm (the Viewer Wasm contents table above shows which crate grew) or raise the limit. To raise, append an entry to ${path} with measured ${JSON.stringify(measured)}, limits ${JSON.stringify(limits)} (measured plus 5% rounded up to 1,000 B), and a new reason naming the change, the Issue, and what the bytes buy. Keep earlier entries unchanged.`,
      );
      process.exitCode = 1;
    }
    try {
      console.log("[wasm-size] " + history(path, source));
    } catch (error) {
      console.log("[wasm-size] Ledger history check failed.");
      throw error;
    }
  } catch (error) {
    console.error(
      `[wasm-size] ${subject}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
main();
