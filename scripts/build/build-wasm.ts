import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, parse } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";

type Unit = { crate: string; depInfo: string };

const artifact = z.object({
  package_id: z.string(),
  target: z.object({ name: z.string(), kind: z.array(z.string()) }),
  filenames: z.array(z.string()),
});

export function parseLocalUnits(output: string): Unit[] {
  const units = new Map<string, Unit>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message: unknown = JSON.parse(line);
    if (z.object({ reason: z.string() }).parse(message).reason !== "compiler-artifact") continue;
    const { package_id, target, filenames } = artifact.parse(message);
    if (!package_id.startsWith("path+file://") || target.kind.includes("custom-build")) continue;
    for (const filename of filenames) {
      const { dir, name } = parse(filename);
      const stem = name.replace(/^lib/u, "");
      const depInfo = join(basename(dir) === "deps" ? dir : join(dir, "deps"), `${stem}.d`);
      units.set(depInfo, { crate: target.name, depInfo });
    }
  }
  return [...units.values()];
}

export function verifyProvenance(units: Unit[]) {
  const errors: string[] = [];
  for (const { crate, depInfo } of units) {
    // Cargo rewrites the top-level .d even for fresh artifacts. Only rustc writes the one in deps.
    const recorded = existsSync(depInfo)
      ? readFileSync(depInfo, "utf8")
          .split("\n")
          .map((line) => /^(.*?):(?: |$)/u.exec(line)?.[1])
          .find((path) => path?.endsWith(`/${basename(depInfo)}`))
      : undefined;
    if (recorded !== depInfo)
      errors.push(`${crate}: ${recorded ?? "missing dep-info target"} (expected ${depInfo})`);
  }
  if (!units.some(({ crate }) => crate === "madori_viewer")) errors.push("No madori_viewer unit");
  if (errors.length)
    throw new Error(`${errors.join("\n")}\nRun pnpm setup so this checkout has its own target.`);
}

export function buildWasm() {
  const root = fileURLToPath(repositoryRoot);
  const bindgen = fileURLToPath(new URL(".tools/bin/wasm-bindgen", repositoryRoot));
  const profile = "release";
  const input = `target/wasm32-unknown-unknown/${profile}/madori_viewer.wasm`;
  try {
    const version = execFileSync(bindgen, ["--version"], { encoding: "utf8" }).trim();
    if (version !== "wasm-bindgen 0.2.129") throw new Error(`Unexpected version: ${version}`);
  } catch (error) {
    throw new Error("Run pnpm setup to install the matching wasm-bindgen CLI.", {
      cause: error,
    });
  }
  console.info(`[wasm] profile=${profile}, wasm-bindgen input=${input}`);
  const output = execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--message-format=json-render-diagnostics",
      "-p",
      "madori-viewer",
      "--target",
      "wasm32-unknown-unknown",
      "--profile",
      profile,
    ],
    {
      cwd: root,
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 ** 2,
    },
  );
  verifyProvenance(parseLocalUnits(output));
  execFileSync(
    bindgen,
    [input, "--target", "web", "--out-dir", "crates/viewer/pkg", "--out-name", "madori_viewer"],
    { cwd: root, stdio: "inherit" },
  );
}

if (import.meta.main) buildWasm();
