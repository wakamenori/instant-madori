import { z } from "zod";
import { assetSchema, type Asset } from "@madori/contracts";
import type { D1 } from "./d1.ts";
import type { R2 } from "./r2.ts";
import {
  createOnceStatements,
  findOnce,
  mapOnce,
  runOnce,
  type Once,
  type RequestKey,
} from "./requests.ts";

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
  const objectKey = `owners/${key.ownerId}/assets/${asset.id}`;
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
