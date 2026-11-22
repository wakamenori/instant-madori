import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const directories = [
  "crates/",
  "apps/geometry/",
  "third_party/",
  "packages/contracts/src/generated/",
  "scripts/generate/",
  "scripts/check/",
  "scripts/shared/",
  "scripts/build/",
];
const filenames = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  "clippy.toml",
  ".clippy.toml",
  "rustfmt.toml",
  ".rustfmt.toml",
  "deny.toml",
  "mise.toml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);

export function isRustInput(path: string) {
  return (
    directories.some((dir) => path.startsWith(dir)) ||
    filenames.has(basename(path)) ||
    path.endsWith(".rs") ||
    path.split("/").includes(".cargo")
  );
}

/** A merge base is returned only when every source of changes rules out Rust inputs. */
export function rustSkipBase(cwd: string, forceRust: boolean, githubActions: string | undefined) {
  if (forceRust || githubActions !== undefined) return;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const base = git("merge-base", "HEAD", "origin/main").trim();
    const diff = ["diff", "--no-renames", "--name-only", "-z"];
    // Check each layer separately: an unstaged edit can undo a staged or committed change.
    for (const args of [
      [...diff, base, "HEAD"],
      [...diff, "--cached", "HEAD"],
      diff,
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ]) {
      if (
        git(...args)
          .split("\0")
          .some(isRustInput)
      )
        return;
    }
    return base;
  } catch {
    return;
  }
}
