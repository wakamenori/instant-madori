import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

class UsageError extends Error {}

function checkout() {
  const git = (...args) =>
    execFileSync("git", ["rev-parse", ...args], { encoding: "utf8", stdio: "pipe" }).replace(
      /\n$/,
      "",
    );
  try {
    return {
      top: git("--show-toplevel"),
      main: dirname(git("--path-format=absolute", "--git-common-dir")),
    };
  } catch {
    return { top: "", main: "" };
  }
}

function main() {
  if (process.argv.length !== 2) throw new UsageError("usage: poteto-mode.mjs");
  const config = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, ".claude");
  const { plugins } = JSON.parse(
    readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"),
  );
  const installs = Object.entries(plugins)
    .filter(([key]) => key.startsWith("pstack@"))
    .flatMap(([, records]) => {
      if (!Array.isArray(records)) throw new Error("invalid pstack install records");
      return records;
    });
  const { top, main } = checkout();
  const here = (i) => top && (i.projectPath === top || i.projectPath === main);
  const chosen =
    installs.find((i) => i?.scope === "local" && here(i)) ??
    installs.find((i) => i?.scope === "project" && here(i)) ??
    installs.find((i) => i?.scope === "user");
  if (typeof chosen?.installPath !== "string") throw new Error("no matching install path");
  const file = resolve(chosen.installPath, "skills/poteto-mode/SKILL.md");
  if (!statSync(file).isFile()) throw new Error(`${file} is not a file`);
  console.log(file);
}
try {
  main();
} catch (error) {
  console.error(
    `poteto-mode: ${error instanceof UsageError ? "" : "poteto-mode SKILL.md not found: "}${error.message}`,
  );
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
