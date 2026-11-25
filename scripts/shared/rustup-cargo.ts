import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Finding =
  | { kind: "rustup"; cargo: string }
  | { kind: "other"; cargo: string; real: string; evidence: string }
  | { kind: "missing" };

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstLine(output: string | null) {
  return output?.trim().split(/\r?\n/u, 1)[0]?.slice(0, 200);
}

function evidence(result: SpawnSyncReturns<string>) {
  const stdout = firstLine(result.stdout);
  const stderr = firstLine(result.stderr);
  let reason: string;
  if (result.error) {
    const { code } = result.error as NodeJS.ErrnoException;
    reason = code === "ETIMEDOUT" ? "it did not answer within 5 s" : `it could not start (${code})`;
  } else if (result.signal) reason = `it was killed by ${result.signal}`;
  else if (stdout) reason = `it printed "${stdout}"`;
  else reason = `it printed nothing and exited with ${result.status}`;
  return !stdout && stderr ? `${reason}: ${stderr}` : reason;
}

function findCargo(): Finding {
  const cargo = process.env.PATH?.split(":")
    .map((dir) => resolve(dir, "cargo"))
    .find(executable);
  if (!cargo) return { kind: "missing" };
  const root = mkdtempSync(join(resolve(tmpdir()), "madori-rustup-probe-"));
  try {
    // Linking cargo to Node makes only a rustup proxy print Node's version without a script in TMPDIR.
    const toolchain = join(root, "toolchain");
    const bin = join(toolchain, "bin");
    const home = join(root, "home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home);
    symlinkSync(process.execPath, join(bin, "cargo"));
    symlinkSync(process.execPath, join(bin, "rustc"));
    const result = spawnSync(cargo, ["--version"], {
      cwd: root,
      env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain, RUSTUP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    if (!result.error && result.status === 0 && result.stdout.trim() === process.version)
      return { kind: "rustup", cargo };
    return { kind: "other", cargo, real: realpathSync(cargo), evidence: evidence(result) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function message(
  finding: Finding,
  rustupBin: string,
  rustupThere: boolean,
  event: string | undefined,
) {
  if (finding.kind === "rustup") return `[rustup] cargo=${finding.cargo} (rustup proxy)`;
  const lines =
    finding.kind === "other"
      ? [
          `[rustup] cargo on PATH is ${finding.cargo}${finding.real === finding.cargo ? "" : ` (-> ${finding.real})`}, and it is not rustup's proxy: asked to run another toolchain through RUSTUP_TOOLCHAIN, ${finding.evidence}.`,
          'rust-toolchain.toml pins the Rust toolchain and its wasm32-unknown-unknown target, and only rustup applies them; another cargo fails the Wasm build with "can\'t find crate for core".',
        ]
      : [
          "[rustup] cargo is not on PATH.",
          "This repository builds Rust with rustup's cargo, which applies the toolchain and Wasm target that rust-toolchain.toml pins.",
        ];
  const pathFix = (folder: string) =>
    finding.kind === "other"
      ? `put ${folder} before ${dirname(finding.cargo)} on PATH.`
      : `add ${folder} to PATH.`;
  if (rustupThere) {
    const rerun = event
      ? `rerun it through mise with the same arguments (\`mise exec -- pnpm ${event} ...\`)`
      : "rerun it through mise (`mise exec -- <command>`)";
    lines.push(
      `Fix: ${rerun}; mise.toml puts ${rustupBin} first on PATH.`,
      `Without mise, ${pathFix(rustupBin)}`,
    );
  } else {
    lines.push(
      `rustup's cargo is not in ${rustupBin}, where mise.toml looks for it.`,
      "Fix: install rustup (https://rustup.rs), then run `mise exec -- pnpm setup`.",
      `If rustup is installed elsewhere, such as Homebrew's rustup in $(brew --prefix rustup)/bin, ${pathFix("that folder")}`,
    );
  }
  return lines.join("\n");
}

export function checkRustupCargo(): boolean {
  const finding = findCargo();
  const rustupBin = join(process.env.CARGO_HOME || join(homedir(), ".cargo"), "bin");
  const expected = resolve(rustupBin, "cargo");
  const rustupThere =
    (finding.kind !== "other" || expected !== finding.cargo) && executable(expected);
  const output = message(finding, rustupBin, rustupThere, process.env.npm_lifecycle_event);
  if (finding.kind === "rustup") {
    console.info(output);
    return true;
  }
  console.error(output);
  process.exitCode = 1;
  return false;
}

if (import.meta.main) checkRustupCargo();
