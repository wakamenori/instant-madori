import type { Asset } from "@madori/contracts";
import type { AssetContent } from "../storage/assets.ts";
import { limits } from "../limits.ts";
import type { OwnerId } from "../owner.ts";
import type { ServiceDeps, StoreDeps } from "./deps.ts";
import { imageFormats, parseAssetMediaType } from "./image-formats.ts";
import { requestKey } from "./requests.ts";

export const assetUploadMaxBytes = limits.assets.maxBytes;

export type CreateAssetOutcome =
  | { kind: "created"; asset: Asset }
  | { kind: "unsupported_media_type" }
  | { kind: "payload_too_large" }
  | { kind: "invalid_image" }
  | { kind: "image_dimensions_too_large" }
  | { kind: "request_id_reused" };

export async function createAsset(
  { store, runtime }: StoreDeps<"assets", "createOnce"> & Pick<ServiceDeps, "runtime">,
  {
    ownerId,
    requestId,
    contentType,
    bytes,
  }: {
    ownerId: OwnerId;
    requestId: string;
    contentType: string | null;
    bytes: Uint8Array<ArrayBuffer>;
  },
): Promise<CreateAssetOutcome> {
  const mediaType = parseAssetMediaType(contentType);
  if (!mediaType) return { kind: "unsupported_media_type" };
  if (bytes.byteLength > assetUploadMaxBytes) return { kind: "payload_too_large" };
  const format = imageFormats[mediaType];
  if (!format.signature.every((byte, index) => byte === bytes[index]))
    return { kind: "invalid_image" };
  const header = format.readHeader(bytes);
  if (header.kind === "invalid") return { kind: "invalid_image" };
  if (header.kind === "unsupported") return { kind: "unsupported_media_type" };
  const { width, height } = header;
  if (width > limits.assets.maxEdgePx || height > limits.assets.maxEdgePx)
    return { kind: "image_dimensions_too_large" };
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = await requestKey(ownerId, requestId, "asset.create", { mediaType, sha256 });
  const once = await store.assets.createOnce(key, {
    id: runtime.newId(),
    now: runtime.now(),
    bytes,
    width,
    height,
    mediaType,
    sha256,
  });
  if (once.kind === "request_id_reused") return once;
  if (once.kind === "not_applied") throw new Error("Unconditional asset insert did not apply");
  return { kind: "created", asset: once.result };
}

export async function readAsset(
  { store }: StoreDeps<"assets", "open">,
  scope: { ownerId: OwnerId; assetId: string },
): Promise<{ kind: "found"; content: AssetContent } | { kind: "not_found" }> {
  const content = await store.assets.open(scope);
  return content === null ? { kind: "not_found" } : { kind: "found", content };
}
