import { assetMediaTypeSchema } from "@madori/contracts";
import type { AssetMediaType } from "@madori/contracts";

type ImageHeader =
  { kind: "read"; width: number; height: number } | { kind: "unsupported" } | { kind: "invalid" };

interface ImageFormat {
  readonly signature: readonly number[];
  readHeader(bytes: Uint8Array): ImageHeader;
}

const depthsByColor = new Map<number, readonly number[]>([
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
]);

const png: ImageFormat = {
  signature: [137, 80, 78, 71, 13, 10, 26, 10],
  readHeader(bytes) {
    if (bytes.length < 33) return { kind: "invalid" };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return { kind: "invalid" };
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (
      width === 0 ||
      height === 0 ||
      width > 0x7fffffff ||
      height > 0x7fffffff ||
      !depthsByColor.get(view.getUint8(25))?.includes(view.getUint8(24))
    )
      return { kind: "invalid" };
    return { kind: "read", width, height };
  },
};

const otherFrameMarkers = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const jpeg: ImageFormat = {
  signature: [0xff, 0xd8],
  readHeader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // A later frame can override the first frame in some decoders.
    let frame: Extract<ImageHeader, { kind: "read" }> | undefined;
    let pos = 2;
    while (bytes[pos] === 0xff) {
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++];
      if (
        marker === undefined ||
        marker === 0 ||
        marker === 1 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0xd8
      )
        return { kind: "invalid" };
      if (marker === 0xd9) return frame ?? { kind: "invalid" };
      if (pos + 2 > bytes.length) return { kind: "invalid" };
      const length = view.getUint16(pos);
      if (length < 2 || pos + length > bytes.length) return { kind: "invalid" };
      if (marker >= 0xc0 && marker <= 0xc2) {
        if (frame || length < 8) return { kind: "invalid" };
        const components = view.getUint8(pos + 7);
        if (length !== 8 + 3 * components) return { kind: "invalid" };
        const height = view.getUint16(pos + 3);
        const width = view.getUint16(pos + 5);
        if (view.getUint8(pos + 2) !== 8 || (components !== 1 && components !== 3) || height === 0)
          return { kind: "unsupported" };
        if (width === 0) return { kind: "invalid" };
        frame = { kind: "read", width, height };
      }
      if (otherFrameMarkers.has(marker)) return { kind: "unsupported" };
      // Some decoders consume a five-byte APP0 identifier even with only four payload bytes.
      if (marker === 0xe0 && length === 6) return { kind: "invalid" };
      pos += length;
      if (marker === 0xda) {
        if (!frame) return { kind: "invalid" };
        while (true) {
          pos = bytes.indexOf(0xff, pos);
          if (pos < 0 || pos + 1 >= bytes.length) return { kind: "invalid" };
          const next = view.getUint8(pos + 1);
          if (next === 0xff) pos++;
          else if (next === 0 || (next >= 0xd0 && next <= 0xd7)) pos += 2;
          else break;
        }
      }
    }
    return { kind: "invalid" };
  },
};

export const imageFormats = { "image/png": png, "image/jpeg": jpeg } as const satisfies Record<
  AssetMediaType,
  ImageFormat
>;

export function parseAssetMediaType(contentType: string | null): AssetMediaType | null {
  const essence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return assetMediaTypeSchema.safeParse(essence).data ?? null;
}
