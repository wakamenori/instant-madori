import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { repositoryRoot } from "./repository.ts";

const script = fileURLToPath(new URL("./rustup-cargo.ts", import.meta.url));
const proxy = '#!/bin/sh\nexec "$RUSTUP_TOOLCHAIN/bin/cargo" "$@"';
const foreign = '#!/bin/sh\necho "cargo 1.100.0 (Homebrew)"';
function executable(path: string, body: string, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body + "\n", { mode });
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rustup-cargo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cargoHome = join(root, "cargo-home");
  const tmp = join(root, "tmp");
  const bin = join(root, "bin");
  for (const dir of [home, cargoHome, tmp, bin]) mkdirSync(dir);
  const cargo = join(bin, "cargo");
  const expected = join(cargoHome, "bin/cargo");
  const run = (env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: bin, HOME: home, CARGO_HOME: cargoHome, TMPDIR: tmp, ...env },
    });
  return { root, home, tmp, bin, cargo, cargoHome, expected, run };
}

void test("accepts a cargo that runs the named toolchain", (t) => {
  const f = fixture(t);
  executable(f.cargo, proxy);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `[rustup] cargo=${f.cargo} (rustup proxy)`);
});

void test("accepts Homebrew's rustup wrapper", (t) => {
  const f = fixture(t);
  const wrapped = join(f.root, "libexec/bin/cargo");
  executable(wrapped, proxy);
  executable(
    f.cargo,
    `#!/bin/bash\nRUSTUP_OVERRIDE_UNIX_FALLBACK_SETTINGS="/x/settings.toml" exec "${wrapped}"  "$@"`,
  );
  executable(join(f.bin, "rustup"), "#!/bin/sh\nexit 1");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

void test("accepts the installed rustup", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(rustup proxy\)/u);
});

void test("rejects the first cargo even with a proxy later on PATH", (t) => {
  const f = fixture(t);
  executable(f.cargo, foreign);
  executable(f.expected, proxy);
  const result = f.run({ PATH: [f.bin, dirname(f.expected)].join(":") });
  assert.equal(result.status, 1);
  assert(result.stderr.includes(f.cargo));
  assert(result.stderr.includes('it printed "cargo 1.100.0 (Homebrew)"'));
  assert(result.stderr.includes("can't find crate for core"));
  assert(!result.stdout.includes("[rustup] cargo="));
});

void test("shows the lifecycle command and cargo home to put first", (t) => {
  const f = fixture(t);
  executable(f.cargo, foreign);
  executable(f.expected, proxy);
  const { stderr } = f.run({ npm_lifecycle_event: "dev" });
  assert(stderr.includes("mise exec -- pnpm dev"));
  assert(stderr.includes(`put ${dirname(f.expected)} before ${f.bin}`));
  assert(!stderr.includes("https://rustup.rs"));
});

void test("asks for rustup when cargo home has no proxy", (t) => {
  const f = fixture(t);
  executable(f.cargo, foreign);
  const { stderr } = f.run();
  assert(stderr.includes(`rustup's cargo is not in ${dirname(f.expected)}`));
  assert(stderr.includes("https://rustup.rs"));
  assert(stderr.includes("brew --prefix rustup"));
  assert(!stderr.includes("rerun it through mise"));
});

void test("defaults to ~/.cargo", (t) => {
  const f = fixture(t);
  executable(f.cargo, foreign);
  const bin = join(f.home, ".cargo/bin");
  executable(join(bin, "cargo"), proxy);
  assert(f.run({ CARGO_HOME: undefined }).stderr.includes(`put ${bin} before`));
});

for (const installed of [true, false]) {
  void test(`reports missing cargo when rustup installed is ${installed}`, (t) => {
    const f = fixture(t);
    if (installed) executable(f.expected, proxy);
    const result = f.run();
    assert.equal(result.status, 1);
    assert(result.stderr.includes("cargo is not on PATH"));
    assert(
      result.stderr.includes(
        installed ? `add ${dirname(f.expected)} to PATH` : "https://rustup.rs",
      ),
    );
    assert.doesNotMatch(result.stderr, /another cargo|can't find crate/u);
  });
}

void test("direct runs get a generic mise command", (t) => {
  const f = fixture(t);
  executable(f.expected, proxy);
  const { stderr } = f.run();
  assert(stderr.includes("mise exec -- <command>"));
  assert(!stderr.includes("mise exec -- pnpm"));
});

void test("skips a non-executable cargo", (t) => {
  const f = fixture(t);
  executable(f.cargo, foreign, 0o644);
  executable(f.expected, proxy);
  const result = f.run({ PATH: [f.bin, dirname(f.expected)].join(":") });
  assert.equal(result.status, 0, result.stderr);
  assert(result.stdout.includes(f.expected));
});

void test("stops when cargo does not answer", (t) => {
  const f = fixture(t);
  executable(f.cargo, "#!/bin/sh\nexec sleep 30");
  const start = Date.now();
  const result = f.run({ PATH: f.bin + ":/usr/bin:/bin" });
  assert(Date.now() - start < 10000);
  assert.equal(result.status, 1);
  assert(result.stderr.includes("did not answer within 5 s"), result.stderr);
});

void test("stops when cargo cannot start", (t) => {
  const f = fixture(t);
  executable(f.cargo, "#!/nonexistent/sh");
  const result = f.run();
  assert.equal(result.status, 1);
  assert(result.stderr.includes("could not start"), result.stderr);
});

void test("leaves the caller's rustup home and TMPDIR empty", (t) => {
  const f = fixture(t);
  executable(
    f.cargo,
    '#!/bin/sh\ntouch "$RUSTUP_HOME/written" || exit 1\nexec "$RUSTUP_TOOLCHAIN/bin/cargo" "$@"',
  );
  const result = f.run({ RUSTUP_HOME: f.home, PATH: f.bin + ":/usr/bin:/bin" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(readdirSync(f.tmp), []);
});

void test("accepts a relative TMPDIR", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "rel"));
  executable(f.cargo, proxy);
  const result = f.run({ TMPDIR: "rel" });
  assert.equal(result.status, 0, result.stderr);
});

void test("every cargo entry point starts with the rustup check", () => {
  const { scripts } = z
    .object({
      scripts: z.object({
        setup: z.string(),
        dev: z.string(),
        build: z.string(),
        check: z.string(),
      }),
    })
    .parse(JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")));
  function innerChain(name: "setup" | "build") {
    const prefix = `node metrics/hook/run-span.ts ${name} -- sh -c '`;
    const suffix = ` "$@"' ${name}`;
    assert.ok(scripts[name].startsWith(prefix) && scripts[name].endsWith(suffix));
    return scripts[name].slice(prefix.length, -suffix.length);
  }
  assert.deepEqual(innerChain("setup").split(" && ").slice(0, 2), [
    "node scripts/shared/rustup-cargo.ts",
    "mise install",
  ]);
  for (const command of [scripts.dev, innerChain("build")])
    assert.equal(command.split(" && ")[0], "node scripts/build/build-wasm.ts");
  assert.equal(scripts.check, "node metrics/hook/run-span.ts check -- node scripts/check/check.ts");
});

void test("mise keeps cargo home first after activation", (t) => {
  const f = fixture(t);
  const mise = process.env.PATH?.split(":")
    .map((dir) => resolve(dir, "mise"))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
  assert(mise, "The repository requires mise on PATH");
  const project = join(f.root, "project");
  mkdirSync(project);
  copyFileSync(new URL("mise.toml", repositoryRoot), join(project, "mise.toml"));
  const globalConfig = join(f.root, "empty.toml");
  writeFileSync(globalConfig, "");
  const brew = join(f.root, "brew");
  executable(join(brew, "cargo"), foreign);
  for (const cargoHome of [f.cargoHome, undefined]) {
    const expected = join(cargoHome ?? join(f.home, ".cargo"), "bin/cargo");
    executable(expected, proxy);
    const result = spawnSync(
      "bash",
      [
        "-c",
        'eval "$(mise hook-env -s bash)"; export PATH="$BREW:$PATH"; mise exec -- sh -c "command -v cargo"',
      ],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          HOME: f.home,
          PATH: dirname(mise) + ":/usr/bin:/bin",
          BREW: brew,
          CARGO_HOME: cargoHome,
          MISE_TRUSTED_CONFIG_PATHS: project,
          MISE_GLOBAL_CONFIG_FILE: globalConfig,
          MISE_CEILING_PATHS: f.root,
          MISE_EXEC_AUTO_INSTALL: "0",
        },
      },
    );
    if (result.status !== 0 || result.stdout.trim() !== expected) {
      const version = spawnSync(mise, ["--version"], { encoding: "utf8" }).stdout;
      assert.fail(`expected ${expected}\n${result.stdout}\n${result.stderr}\n${version}`);
    }
  }
});
