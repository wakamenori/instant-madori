import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createAccessKey, MissingAccessKey, readAccessKey } from "./local-access.ts";

await test("Local Access key file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "madori-access-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = (name: string) => pathToFileURL(join(directory, name));

  await t.test("a stored key reads back unchanged", async () => {
    const key = await createAccessKey("https://access.test.invalid", "aud");
    await writeFile(file("valid.json"), JSON.stringify(key));
    assert.deepEqual(await readAccessKey(file("valid.json")), key);
  });

  await t.test("a missing file asks the developer to run pnpm dev", async () => {
    await assert.rejects(readAccessKey(file("missing.json")), /Start the app with `pnpm dev`/);
  });

  await t.test("an unreadable key is reported as it is, never as missing", async () => {
    // A directory at the key's path cannot be read; treating it as missing would let
    // `pnpm dev` generate a new key and replace the developer's.
    await mkdir(join(directory, "unreadable.json"));
    await assert.rejects(readAccessKey(file("unreadable.json")), (error) => {
      assert.ok(!(error instanceof MissingAccessKey));
      return error instanceof Error && "code" in error && error.code === "EISDIR";
    });
  });

  for (const [label, content] of [
    ["truncated JSON", '{"issuer": "https://access'],
    ["JSON of the wrong shape", JSON.stringify({ issuer: "x" })],
  ] as const) {
    await t.test(`${label} gives the recovery message, not a raw parse error`, async () => {
      await writeFile(file("broken.json"), content);
      await assert.rejects(
        readAccessKey(file("broken.json")),
        /is malformed\. Delete it and rerun\./,
      );
    });
  }
});
