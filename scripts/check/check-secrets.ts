import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Include untracked source, but leave legitimate gitignored credentials on the developer's machine.
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ":(exclude)third_party/solidcraft",
  ],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const snapshot = await mkdtemp(join(tmpdir(), "madori-secret-scan-"));
try {
  for (const file of new Set(files)) {
    const stat = await lstat(file).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    // Deleted tracked files and symlinks have no file contents to scan.
    if (!stat?.isFile()) continue;
    const destination = join(snapshot, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
  }
  execFileSync(
    "mise",
    [
      "exec",
      "--",
      "gitleaks",
      "dir",
      "--config",
      resolve(".gitleaks.toml"),
      "--redact",
      "--verbose",
      "--no-banner",
      snapshot,
    ],
    { stdio: "inherit" },
  );
} finally {
  await rm(snapshot, { recursive: true, force: true });
}
