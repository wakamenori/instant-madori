import assert from "node:assert/strict";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";
import { d1, jsonRows, rows, write } from "../../src/storage/d1.ts";
import { r2 } from "../../src/storage/r2.ts";
import { StorageCorruption } from "../../src/storage/rows.ts";

void test("storage adapters validate real D1 results and reject R2 overwrites", async () => {
  const proxy = await getPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
    configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
  });
  try {
    const database = d1(proxy.env.DB);
    const item = z.object({ name: z.string() });
    const result = await database.batch([
      write({ sql: "CREATE TABLE adapter_test (value TEXT NOT NULL)", bindings: [] }),
      rows(
        {
          sql: "INSERT INTO adapter_test VALUES (?) RETURNING value AS result",
          bindings: ['{"name":"saved"}'],
        },
        z.object({ result: z.string() }),
        "record",
      ),
      jsonRows({ sql: "SELECT value AS json FROM adapter_test", bindings: [] }, item, "item"),
    ]);
    assert.deepEqual(result, [undefined, [{ result: '{"name":"saved"}' }], [{ name: "saved" }]]);
    assert.deepEqual(
      await database.first(
        jsonRows({ sql: "SELECT value AS json FROM adapter_test", bindings: [] }, item, "item"),
      ),
      { name: "saved" },
    );
    assert.equal(
      await database.first(
        jsonRows(
          { sql: "SELECT value AS json FROM adapter_test WHERE 0", bindings: [] },
          item,
          "item",
        ),
      ),
      null,
    );
    for (const json of ['{"name":1}', "{invalid", 42]) {
      await assert.rejects(
        database.all(jsonRows({ sql: "SELECT ? AS json", bindings: [json] }, item, "item")),
        StorageCorruption,
      );
    }
    await assert.rejects(
      database.batch([
        rows(
          { sql: "SELECT 'bad' AS found", bindings: [] },
          z.object({ found: z.literal(1) }),
          "existence",
        ),
      ]),
      StorageCorruption,
    );
    await assert.rejects(
      database.batch([
        write({ sql: "INSERT INTO adapter_test VALUES ('rolled back')", bindings: [] }),
        write({ sql: "INSERT INTO adapter_test VALUES (NULL)", bindings: [] }),
      ]),
      /NOT NULL constraint failed/,
    );
    assert.deepEqual(
      await database.all(
        jsonRows({ sql: "SELECT value AS json FROM adapter_test", bindings: [] }, item, "item"),
      ),
      [{ name: "saved" }],
    );

    const bucket = r2(proxy.env.BLOBS);
    const key = "adapter-test";
    assert.equal(await bucket.read(key), null);
    await bucket.putNew(key, new Uint8Array([1, 2]), "application/octet-stream");
    await assert.rejects(
      bucket.putNew(key, new Uint8Array([3, 4]), "application/octet-stream"),
      /already exists/,
    );
    assert.deepEqual(await bucket.read(key), { bytes: new Uint8Array([1, 2]) });
  } finally {
    await proxy.dispose();
  }
});
