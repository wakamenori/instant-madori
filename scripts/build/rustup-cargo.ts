import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Cargo =
  | { kind: "rustup"; path: string }
  | { kind: "other"; path: string; real: string }
  | { kind: "missing" };

function isRustupProxy(path: string, cargo: { dev: bigint; ino: bigint }): boolean {
  try {
    const rustup = statSync(join(dirname(path), "rustup"), { bigint: true });
    return cargo.dev === rustup.dev && cargo.ino === rustup.ino;
  } catch {
    return false;
  }
}

function findCargo(): Cargo {
  for (const directory of process.env.PATH?.split(":") ?? []) {
    const path = resolve(directory, "cargo");
    try {
      accessSync(path, constants.X_OK);
      const cargo = statSync(path, { bigint: true });
      if (!cargo.isFile()) continue;
      if (isRustupProxy(path, cargo)) {
        return { kind: "rustup", path };
      }
      return { kind: "other", path, real: realpathSync(path) };
    } catch {
      continue;
    }
  }
  return { kind: "missing" };
}

const cargo = findCargo();
if (cargo.kind === "rustup") {
  console.info(`[rustup] cargo=${cargo.path} (rustup proxy)`);
} else {
  const location =
    cargo.kind === "missing"
      ? "cargo is not on PATH."
      : `cargo on PATH is ${cargo.path}${cargo.real === cargo.path ? "" : ` (-> ${cargo.real})`}, not a rustup proxy.`;
  const before = cargo.kind === "other" ? ` before ${dirname(cargo.path)}` : "";
  console.error(
    `[rustup] ${location}\n` +
      'rust-toolchain.toml pins the Rust toolchain and its wasm32-unknown-unknown target, and only rustup applies them; another cargo fails the Wasm build with "can\'t find crate for core".\n' +
      "Fix: install rustup (https://rustup.rs) and run `mise exec -- pnpm setup`; mise.toml puts $CARGO_HOME/bin first on PATH.\n" +
      `Without mise, put the directory of rustup's cargo${before} on PATH.`,
  );
  process.exitCode = 1;
}
