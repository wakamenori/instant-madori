import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { z } from "zod";
import {
  accessAssertionHeader,
  createAssetResponseSchema,
  meResponseSchema,
} from "@madori/contracts";
import { signAccessToken } from "../../../scripts/dev/local-access.ts";
import { limits } from "../src/limits.ts";
import { newUser, startLocalWorker, testAppOrigin } from "./support/local-worker.ts";

function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

function png(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((1 + 3 * width) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAA6ADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgADAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/n/ooooA/9k=",
  "base64",
);

const savedSchema = z.object({
  rows: z.array(
    z.object({
      id: z.uuid(),
      owner_id: z.uuid(),
      object_key: z.string(),
      media_type: z.string(),
      bytes: z.number(),
      width: z.number(),
      height: z.number(),
      sha256: z.string(),
      created_at: z.string(),
    }),
  ),
  objects: z.array(
    z.object({ key: z.string(), size: z.number(), contentType: z.string(), sha256: z.string() }),
  ),
});

await test("reference images are validated and stored once per owner request", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());
  const user = newUser("asset-owner");
  const ownerId = meResponseSchema.parse(await (await worker.call("/api/me", { as: user })).json())
    .user.id;
  const token = await signAccessToken(worker.key, user);
  const image = png(4, 2);
  async function upload(
    body: Uint8Array<ArrayBuffer>,
    type: string | null,
    {
      query = `requestId=${crypto.randomUUID()}`,
      origin = testAppOrigin,
      authenticated = true,
    } = {},
  ) {
    const headers = new Headers({ origin });
    if (type) headers.set("content-type", type);
    if (authenticated) headers.set(accessAssertionHeader, token);
    return fetch(`${worker.origin}/api/assets?${query}`, { method: "POST", headers, body });
  }
  function saved() {
    return worker.withPausedWorker(async (state) => {
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./rpc/assets-fixture.ts", import.meta.url)),
        state,
        ownerId,
      ]);
      return savedSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
    });
  }
  async function rejected(response: Response, status: number, error: string) {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  const query = `requestId=${crypto.randomUUID()}`;
  await rejected(
    await upload(image, "image/png", { authenticated: false }),
    401,
    "unauthenticated",
  );
  await rejected(
    await upload(image, "image/png", { origin: "http://evil.test" }),
    403,
    "forbidden",
  );
  for (const bad of ["", "requestId=no", query + "&" + query, query + "&extra=yes"])
    await rejected(await upload(image, "image/png", { query: bad }), 400, "invalid_request");
  const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert(frame >= 0);
  const deep = Buffer.from(jpeg);
  deep[frame + 4] = 12;
  const tall = Buffer.from(jpeg);
  tall.writeUInt16BE(2577, frame + 5);
  const large = Buffer.alloc(limits.assets.maxBytes + 1);
  image.copy(large);
  for (const [body, type, status, error] of [
    [image, null, 415, "unsupported_media_type"],
    [Buffer.from("GIF89a"), "image/gif", 415, "unsupported_media_type"],
    [jpeg, "image/png", 422, "invalid_image"],
    [image.subarray(0, 16), "image/png", 422, "invalid_image"],
    [deep, "image/jpeg", 415, "unsupported_media_type"],
    [large, "image/png", 413, "payload_too_large"],
    [png(2577, 1), "image/png", 422, "image_dimensions_too_large"],
    [tall, "image/jpeg", 422, "image_dimensions_too_large"],
  ] as const)
    await rejected(await upload(body, type, { query }), status, error);
  assert.deepEqual(await saved(), { rows: [], objects: [] });

  const expectedRows = [];
  const expectedObjects = [];
  for (const [body, type, width, height] of [
    [image, "image/png", 4, 2],
    [jpeg, "image/jpeg", 3, 2],
  ] as const) {
    const request = { query: type === "image/png" ? query : `requestId=${crypto.randomUUID()}` };
    const response = await upload(body, type, request);
    assert.equal(response.status, 201);
    const text = await response.text();
    const { asset } = createAssetResponseSchema.parse(JSON.parse(text));
    const sha256 = createHash("sha256").update(body).digest("hex");
    assert.deepEqual(asset, {
      id: asset.id,
      createdAt: asset.createdAt,
      width,
      height,
      bytes: body.length,
      mediaType: type,
      sha256,
    });
    const key = `owners/${ownerId}/assets/${asset.id}`;
    expectedRows.push({
      id: asset.id,
      owner_id: ownerId,
      object_key: key,
      media_type: type,
      bytes: body.length,
      width,
      height,
      sha256,
      created_at: asset.createdAt,
    });
    expectedObjects.push({ key, size: body.length, contentType: type, sha256 });
    const replay = await upload(body, type, request);
    assert.equal(replay.status, 201);
    assert.equal(await replay.text(), text);
  }
  await rejected(await upload(png(1, 1), "image/png", { query }), 422, "request_id_reused");
  assert.deepEqual(await saved(), {
    rows: expectedRows.sort((a, b) => a.id.localeCompare(b.id)),
    objects: expectedObjects.sort((a, b) => a.key.localeCompare(b.key)),
  });
  const duplicate = { query: `requestId=${crypto.randomUUID()}` };
  const [first, second] = await Promise.all([
    upload(image, "image/png", duplicate),
    upload(image, "image/png", duplicate),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(await first.text(), await second.text());
  const final = await saved();
  assert.equal(final.rows.length, 3);
  assert(final.objects.length >= 3 && final.objects.length <= 4);
});
