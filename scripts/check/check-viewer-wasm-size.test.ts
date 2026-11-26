import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./check-viewer-wasm-size.ts", import.meta.url));
const realLedger = fileURLToPath(new URL("./check-viewer-wasm-size.json", import.meta.url));
const first = {
  limits: { raw: 300, gzip: 300 },
  measured: { raw: 10, gzip: 10 },
  reason: "The initial test fixture budget.",
};
const second = {
  ...first,
  limits: { raw: 400, gzip: 400 },
  reason: "Allow a larger test payload.",
};
function fixture(t: TestContext, payload = Buffer.alloc(110)) {
  const cwd = mkdtempSync(join(tmpdir(), "madori-wasm-size-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "config"));
  const ledger = join(cwd, "config", "ledger.json");
  const wasm = join(cwd, "viewer.wasm");
  // A single-byte section length fits the payload and the empty custom section name.
  assert(payload.length < 127);
  const bytes = Buffer.concat([
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, payload.length + 1, 0]),
    payload,
  ]);
  writeFileSync(wasm, bytes);
  const write = (...entries: unknown[]) => writeFileSync(ledger, JSON.stringify({ entries }));
  write(first);
  const run = (path = ledger) =>
    spawnSync(process.execPath, [cli, wasm, path], { cwd, encoding: "utf8" });
  return { cwd, wasm, write, run, size: bytes.length, ledger };
}
void test("prints all sizes and signed growth when raw equals the limit", (t) => {
  const f = fixture(t);
  f.write({
    ...first,
    limits: { ...first.limits, raw: f.size },
    measured: { ...first.measured, raw: f.size - 100 },
  });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  for (const label of ["raw", "gzip -9", "brotli q11", "zstd -3"])
    assert(r.stdout.includes("| " + label + " |"));
  assert.match(r.stdout, /\| raw .*0 \(0\.0%\).*\+100/u);
  assert.match(r.stdout, /outside a git work tree/u);
});
void test("reports raw over by one byte with the raise procedure", (t) => {
  const f = fixture(t);
  f.write({ ...first, limits: { ...first.limits, raw: f.size - 1 } });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /raw: .* by 1 B/u);
  assert(r.stderr.includes(f.ledger));
  assert.match(r.stderr, /reason/u);
});
void test("gzip can exceed its limit alone", (t) => {
  const f = fixture(t, randomBytes(100));
  f.write({ ...first, limits: { ...first.limits, gzip: 50 } });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gzip -9: .* exceeds/u);
  assert.doesNotMatch(r.stderr, /raw: .* exceeds/u);
  assert.match(r.stdout, /\| gzip -9 \|/u);
});
const refusals: [string, unknown[], string][] = [
  ["missing reason", [{ limits: first.limits, measured: first.measured }], "entries.0.reason"],
  ["blank reason", [{ ...first, reason: " ".repeat(30) }], "entries.0.reason"],
  ["unknown limit", [{ ...first, limits: { ...first.limits, br: 1 } }], "entries.0.limits"],
  ["missing gzip", [{ ...first, limits: { raw: 200 } }], "entries.0.limits"],
  [
    "high measurement",
    [{ ...first, measured: { ...first.measured, raw: 301 } }],
    "entries.0.measured.raw",
  ],
  ["unchanged limits", [first, { ...second, limits: first.limits }], "entries.1.limits"],
  [
    "duplicate reason",
    [first, { ...second, reason: " " + first.reason + " " }],
    "entries.1.reason",
  ],
  ["empty ledger", [], "entries"],
];
for (const [name, entries, path] of refusals)
  void test("rejects " + name, (t) => {
    const f = fixture(t);
    f.write(...entries);
    const r = f.run();
    assert.equal(r.status, 1);
    assert(r.stderr.includes(path), r.stderr);
  });
void test("the last entry supplies the limits", (t) => {
  const f = fixture(t);
  f.write({ ...first, limits: { raw: 10, gzip: 10 } }, second);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Limits from entry 2/u);
});
void test("rejects missing, non-Wasm and wrong-version files", (t) => {
  const f = fixture(t);
  rmSync(f.wasm);
  let r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Run pnpm setup first \(or pnpm check --full\)/u);
  for (const input of [Buffer.from("not wasm"), Buffer.from([0, 97, 115, 109, 2, 0, 0, 0])]) {
    writeFileSync(f.wasm, input);
    r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Wasm magic and version 1/u);
  }
});
void test("history allows only appending to the merge-base ledger", (t) => {
  const f = fixture(t);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: f.cwd },
    );
  git("init", "--initial-branch=main");
  git("commit", "--allow-empty", "-qm", "empty base");
  let r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fetch origin\/main/iu);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no base ledger/iu);
  git("add", "config");
  git("commit", "-qm", "record ledger");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.write({ ...first, limits: { ...first.limits, raw: 999 } });
  r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /append a new entry/iu);
  f.write(first, second);
  r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /History matches/u);
});
void test("committed ledger accepts a small module", (t) => {
  const r = fixture(t).run(realLedger);
  assert.equal(r.status, 0, r.stderr);
});
