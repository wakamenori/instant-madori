import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../shared/repository.ts";

import {
  bindings,
  cacheDirectory,
  cacheWasm,
  platform,
  profile,
  coversBuildScriptInputs,
  coversCompilerInputs,
  wasmFingerprint,
  wasmOutput,
} from "./wasm-cache.ts";

type Unit = { crate: string; depInfo: string };

const artifact = z.object({
  package_id: z.string(),
  target: z.object({ name: z.string(), kind: z.array(z.string()) }),
  filenames: z.array(z.string()),
});

type LocalBuild = { packageDir: string; output: string };

export function parseLocalBuild(output: string) {
  const scripts: LocalBuild[] = [];
  const units = new Map<string, Unit>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message: unknown = JSON.parse(line);
    const { reason } = z.object({ reason: z.string() }).parse(message);
    if (reason === "build-script-executed") {
      const { package_id, out_dir } = z
        .object({ package_id: z.string(), out_dir: z.string() })
        .parse(message);
      if (package_id.startsWith("path+file://"))
        scripts.push({
          packageDir: fileURLToPath(new URL(package_id.slice("path+".length))),
          output: join(dirname(out_dir), "output"),
        });
    }
    if (reason !== "compiler-artifact") continue;
    const { package_id, target, filenames } = artifact.parse(message);
    if (!package_id.startsWith("path+file://") || target.kind.includes("custom-build")) continue;
    for (const filename of filenames) {
      const { dir, name } = parse(filename);
      const stem = name.replace(/^lib/u, "");
      const depInfo = join(basename(dir) === "deps" ? dir : join(dir, "deps"), `${stem}.d`);
      units.set(depInfo, { crate: target.name, depInfo });
    }
  }
  return { units: [...units.values()], scripts };
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

export function buildWasm(root = fileURLToPath(repositoryRoot)) {
  root = resolve(root);
  const bindgen = join(root, ".tools/bin/wasm-bindgen");
  let version: string;
  try {
    version = execFileSync(bindgen, ["--version"], { encoding: "utf8" }).trim();
    if (version !== "wasm-bindgen 0.2.129") throw new Error(`Unexpected version: ${version}`);
  } catch (error) {
    throw new Error("Run pnpm setup to install the matching wasm-bindgen CLI.", {
      cause: error,
    });
  }
  const dir = cacheDirectory(root);
  const build = () => compile(root, bindgen);
  if (!dir) {
    build();
    return;
  }
  cacheWasm(
    root,
    dir,
    () => wasmFingerprint(root, version),
    (files) => {
      const { units, scripts } = build();
      return (
        units.every(({ depInfo }) =>
          coversCompilerInputs(root, files, readFileSync(depInfo, "utf8")),
        ) &&
        scripts.every((script) =>
          coversBuildScriptInputs(
            root,
            files,
            script.packageDir,
            readFileSync(script.output, "utf8"),
          ),
        )
      );
    },
  );
}

function compile(root: string, bindgen: string) {
  console.info(`[wasm] profile=${profile}, wasm-bindgen input=${wasmOutput}`);
  // Cargo must materialize its own artifact after a previous cache restore.
  rmSync(join(root, wasmOutput), { force: true });
  const output = execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--message-format=json-render-diagnostics",
      "-p",
      "madori-viewer",
      "--target",
      platform,
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
  const local = parseLocalBuild(output);
  verifyProvenance(local.units);
  rmSync(join(root, bindings), { recursive: true, force: true });
  execFileSync(
    bindgen,
    [wasmOutput, "--target", "web", "--out-dir", bindings, "--out-name", "madori_viewer"],
    { cwd: root, stdio: "inherit" },
  );
  return local;
}

if (import.meta.main) buildWasm();
