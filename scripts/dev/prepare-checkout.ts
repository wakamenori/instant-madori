import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  lutimesSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";

type Checkout = { root: string; main: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
}

export function findCheckout(cwd: string): Checkout {
  const absolutePath = (flag: string) =>
    git(cwd, ["rev-parse", "--path-format=absolute", flag]).trimEnd();
  return { root: absolutePath("--show-toplevel"), main: dirname(absolutePath("--git-common-dir")) };
}

function localPackageDirs(root: string): string[] {
  const output = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 ** 2,
  });
  const { packages } = z
    .object({
      packages: z.array(z.object({ source: z.string().nullable(), manifest_path: z.string() })),
    })
    .parse(JSON.parse(output));
  return packages.filter((pkg) => pkg.source === null).map((pkg) => dirname(pkg.manifest_path));
}

function markLocalCratesStale(root: string, dirs: string[]) {
  if (dirs.length === 0) return;
  const paths = git(root, [
    "ls-files",
    "-z",
    "--",
    ...dirs.map((dir) => relative(root, dir) || "."),
  ]);
  const now = new Date();
  for (const path of paths.split("\0").filter(Boolean)) {
    const file = join(root, path);
    if (lstatSync(file, { throwIfNoEntry: false })) lutimesSync(file, now, now);
  }
}

function entryState(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return "absent";
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  throw new Error(`Expected a directory or symlink at ${path}`);
}

export function prepareCheckout(
  { root, main }: Checkout,
  deps: { localPackageDirs: (root: string) => string[]; installHooks: (root: string) => void },
) {
  if (root === main) {
    deps.installHooks(root);
    return;
  }
  console.info(`Git hooks stay with the main checkout at ${main}`);
  for (const name of ["target", ".tools"]) {
    const dst = join(root, name);
    switch (entryState(dst)) {
      case "directory":
        continue;
      case "symlink":
        unlinkSync(dst);
        break;
      case "absent":
        break;
    }
    const src = join(main, name);
    if (!existsSync(src)) {
      console.info(`Nothing to clone at ${src}`);
      continue;
    }
    if (statSync(src).dev !== statSync(root).dev) {
      throw new Error(
        `Cloning ${src} across filesystems would make a full copy. Create an empty ${dst} directory to build from scratch.`,
      );
    }
    const tmp = `${dst}.clone-${process.pid}`;
    if (entryState(tmp) !== "absent") throw new Error(`Clone destination already exists: ${tmp}`);
    const start = performance.now();
    try {
      if (process.platform === "darwin") {
        execFileSync("/bin/cp", ["-c", "-R", src, tmp]);
      } else if (process.platform === "linux") {
        execFileSync("cp", ["-R", "--reflink=always", src, tmp]);
      } else {
        throw new Error(`Unsupported clone platform: ${process.platform}`);
      }
      if (name === "target") markLocalCratesStale(root, deps.localPackageDirs(root));
      renameSync(tmp, dst);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
    console.info(`Cloned ${src} to ${dst} in ${((performance.now() - start) / 1000).toFixed(1)} s`);
  }
}

if (import.meta.main) {
  try {
    prepareCheckout(findCheckout(process.cwd()), {
      localPackageDirs,
      installHooks: (cwd) =>
        execFileSync("pnpm", ["exec", "lefthook", "install"], { cwd, stdio: "inherit" }),
    });
  } catch (error) {
    console.error("Checkout preparation failed:", error);
    process.exitCode = 1;
  }
}
