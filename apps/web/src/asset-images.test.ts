import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssetImages } from "./asset-images.ts";

function deferredBlob() {
  let resolve!: (blob: Blob) => void;
  const promise = new Promise<Blob>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

void test("loads an unseeded asset once and uses seeded images without issuing a GET", async (t) => {
  const calls: string[] = [];
  const blob = new Blob(["image"], { type: "image/jpeg" });
  const response = deferredBlob();
  const images = createAssetImages((id) => {
    calls.push(id);
    return response.promise;
  });
  t.after(() => images.dispose());
  const first = images.load("saved");
  await images.load("saved");
  assert.equal(images.get("saved")?.kind, "loading");
  response.resolve(blob);
  await first;
  await images.load("saved");
  images.seed("new", blob);
  await images.load("new");
  assert.deepEqual(calls, ["saved"]);
  for (const id of ["saved", "new"]) {
    const image = images.get(id);
    assert.ok(image?.kind === "ready");
    const local = await fetch(image.url);
    assert.equal(await local.text(), "image");
  }
});

void test("disposing the cache aborts pending reads and revokes ready URLs", async () => {
  const response = deferredBlob();
  let signal: AbortSignal | undefined;
  const images = createAssetImages((_, requestSignal) => {
    signal = requestSignal;
    return response.promise;
  });
  const blob = new Blob(["image"], { type: "image/jpeg" });
  images.seed("ready", blob);
  const ready = images.get("ready");
  assert.ok(ready?.kind === "ready");
  const loading = images.load("pending");
  images.dispose();
  assert.equal(signal?.aborted, true);
  response.resolve(blob);
  await loading;
  assert.equal(images.get("pending"), undefined);
  await assert.rejects(fetch(ready.url));
});
