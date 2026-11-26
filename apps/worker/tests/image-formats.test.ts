import assert from "node:assert/strict";
import { test } from "node:test";
import { imageFormats, parseAssetMediaType } from "../src/services/image-formats.ts";

void test("media type comparison uses the exact normalized essence", () => {
  for (const type of ["IMAGE/PNG", " Image/Png ; foo=bar"])
    assert.equal(parseAssetMediaType(type), "image/png");
  assert.equal(parseAssetMediaType("image/jpeg"), "image/jpeg");
  for (const type of ["image/jpg", "", null]) assert.equal(parseAssetMediaType(type), null);
});

void test("PNG dimensions come from a valid IHDR, including for animated PNGs", () => {
  const png = imageFormats["image/png"];
  const bytes = Buffer.alloc(33);
  bytes.set(png.signature);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(3, 16);
  bytes.writeUInt32BE(5, 20);
  bytes.set([8, 2], 24);
  const read = { kind: "read", width: 3, height: 5 };
  assert.deepEqual(png.readHeader(bytes), read);
  assert.deepEqual(
    png.readHeader(
      Buffer.concat([bytes, Buffer.from("000000086163544c0000000200000000f38d9370", "hex")]),
    ),
    read,
  );
  assert.deepEqual(png.readHeader(bytes.subarray(0, 32)), { kind: "invalid" });
  for (const [offset, value] of [
    [8, 12],
    [16, 0],
    [16, 2 ** 31],
    [12, 0],
  ] as const) {
    const invalid = Buffer.from(bytes);
    invalid.writeUInt32BE(value, offset);
    assert.deepEqual(png.readHeader(invalid), { kind: "invalid" });
  }
  bytes[24] = 4;
  assert.deepEqual(png.readHeader(bytes), { kind: "invalid" });
});

function frame(marker: number, { height = 5, width = 3, precision = 8, components = 3 } = {}) {
  return [
    0xff,
    marker,
    0,
    8 + 3 * components,
    precision,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components,
    ...Buffer.alloc(3 * components),
  ];
}

const dht = [0xff, 0xc4, 0, 20, 0, 1, ...Buffer.alloc(15), 0];
const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0];
const scan = [...dht, ...sos, 0x55];
const eoi = [0xff, 0xd9];

function readJpeg(...segments: number[][]) {
  return imageFormats["image/jpeg"].readHeader(Uint8Array.from([0xff, 0xd8, ...segments.flat()]));
}

void test("JPEG dimensions come from the outer frame through the end of the image", () => {
  const expected = { kind: "read", width: 3, height: 5 };
  for (const marker of [0xc0, 0xc1, 0xc2])
    assert.deepEqual(readJpeg(frame(marker), scan, eoi), expected);
  const thumbnail = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAAFAAkBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AJVD/9k=",
    "base64",
  );
  assert.deepEqual(
    readJpeg([0xff, 0xff, 0xe1, 0, thumbnail.length + 2, ...thumbnail], frame(0xc0), scan, eoi),
    expected,
  );
  assert.deepEqual(readJpeg(frame(0xc0), scan, eoi, frame(0xc1)), expected);
  assert.deepEqual(readJpeg(frame(0xc0, { width: 8000, height: 8000 }), scan, eoi), {
    kind: "read",
    width: 8000,
    height: 8000,
  });
});

void test("JPEG scans allow stuffed bytes, restart markers and further scans", () => {
  const entropy = [0xff, 0, 0xc0];
  for (let marker = 0xd0; marker <= 0xd7; marker++) entropy.push(0xff, marker, 0x55);
  assert.deepEqual(readJpeg(frame(0xc2), scan, entropy, [0xff], scan, eoi), {
    kind: "read",
    width: 3,
    height: 5,
  });
});

void test("JPEG rejects ambiguous frames, misplaced markers and truncated data", () => {
  const first = frame(0xc0);
  const inconsistent = frame(0xc0);
  inconsistent[9] = 1;
  const invalid = { kind: "invalid" };
  for (const prefix of [[0xff, 1], [0xff, 0xd0], [0xff, 0xe0, 0, 6, 0, 0, 0, 0], first, sos])
    assert.deepEqual(readJpeg(prefix, first, scan, eoi), invalid);
  assert.deepEqual(readJpeg(first, scan, frame(0xc2), scan, eoi), invalid);
  assert.deepEqual(imageFormats["image/jpeg"].readHeader(new Uint8Array()), invalid);
  for (const segments of [
    [],
    [[0xff]],
    [eoi],
    [first, scan],
    [first, scan, [0xff]],
    [[0xff, 0], first, scan, eoi],
    [[0xff, 0xd8], first, scan, eoi],
    [[0xff, 0xe1, 0, 8]],
    [[0xff, 0xe0, 0, 1], first, scan, eoi],
    [inconsistent, scan, eoi],
    [frame(0xc0, { width: 0 }), scan, eoi],
  ])
    assert.deepEqual(readJpeg(...segments), invalid);
});

void test("JPEG reports unsupported frame types and sample formats", () => {
  for (const marker of [0xc3, 0xc5, 0xc9])
    assert.deepEqual(readJpeg(frame(marker), scan, eoi), { kind: "unsupported" });
  for (const options of [{ height: 0 }, { precision: 12 }, { components: 4 }])
    assert.deepEqual(readJpeg(frame(0xc0, options), scan, eoi), { kind: "unsupported" });
});
