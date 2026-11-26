import { z } from "zod";
import {
  assetMediaTypeSchema,
  assetSchema,
  type AssetMediaType,
  type Asset,
} from "@madori/contracts";
import type { OwnerId } from "../owner.ts";
import { StorageCorruption } from "./rows.ts";
import { jsonRows, type D1 } from "./d1.ts";
import type { R2 } from "./r2.ts";
import {
  createOnceStatements,
  findOnce,
  mapOnce,
  runOnce,
  type Once,
  type RequestKey,
} from "./requests.ts";

const storedAssetSchema = z.object({
  objectKey: z.string().min(1),
  mediaType: assetMediaTypeSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface AssetContent {
  mediaType: AssetMediaType;
  body: ReadableStream;
}

function assetObjectKey(ownerId: OwnerId, assetId: string) {
  return `owners/${ownerId}/assets/${assetId}`;
}

const createdAssetSchema = z.object({ asset: assetSchema });

export interface NewAsset extends Omit<Asset, "bytes" | "createdAt"> {
  bytes: Uint8Array<ArrayBuffer>;
  now: string;
}

function assetJson(t: string) {
  return `json_object('id', ${t}.id, 'mediaType', ${t}.media_type, 'bytes', ${t}.bytes,
    'width', ${t}.width, 'height', ${t}.height, 'sha256', ${t}.sha256, 'createdAt', ${t}.created_at)`;
}

export async function createAssetOnce(
  db: D1,
  bucket: R2,
  key: RequestKey,
  asset: NewAsset,
): Promise<Once<Asset>> {
  // R2 is outside the D1 batch: answer a recorded request before writing a second object.
  const stored = await findOnce(db, key, createdAssetSchema);
  if (stored) return mapOnce(stored, (result) => result.asset);
  const objectKey = assetObjectKey(key.ownerId, asset.id);
  await bucket.putNew(objectKey, asset.bytes, asset.mediaType, {
    customMetadata: {},
    sha256: asset.sha256,
  });
  const batch = createOnceStatements(key, asset.now, {
    table: "assets",
    id: asset.id,
    statements: [
      {
        sql: `INSERT INTO assets (id, owner_id, object_key, media_type, bytes, width, height, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bindings: [
          asset.id,
          key.ownerId,
          objectKey,
          asset.mediaType,
          asset.bytes.byteLength,
          asset.width,
          asset.height,
          asset.sha256,
          asset.now,
        ],
      },
    ],
    result: {
      sql: `SELECT json_object('asset', ${assetJson("t")}) FROM assets t WHERE t.id = ?`,
      bindings: [asset.id],
    },
  });
  return mapOnce(await runOnce(db, createdAssetSchema, batch), (result) => result.asset);
}

export async function openOwnedAsset(
  db: D1,
  bucket: R2,
  { ownerId, assetId }: { ownerId: OwnerId; assetId: string },
): Promise<AssetContent | null> {
  const row = await db.first(
    jsonRows(
      {
        sql: `SELECT json_object('objectKey', a.object_key, 'mediaType', a.media_type, 'sha256', a.sha256)
      AS json FROM assets a WHERE a.id = ? AND a.owner_id = ?`,
        bindings: [assetId, ownerId],
      },
      storedAssetSchema,
      "asset",
    ),
  );
  if (row === null) return null;
  const hashed = await bucket.digest(row.objectKey);
  if (hashed === null) throw new StorageCorruption("asset object");
  if (hashed.sha256 !== row.sha256) throw new StorageCorruption("asset hash");
  const body = await bucket.stream(row.objectKey, hashed.etag);
  if (body === null) throw new StorageCorruption("asset object");
  return { mediaType: row.mediaType, body };
}
