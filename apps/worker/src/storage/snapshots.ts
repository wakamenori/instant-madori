import type { OwnerId } from "../owner.ts";
import type { R2 } from "./r2.ts";
import { displayContentType } from "@madori/contracts";
import { z } from "zod";
import { parseJsonColumn, StorageCorruption } from "./rows.ts";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const snapshotSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  formatVersion: z.literal(1),
  manifestKey: z.string().min(1),
  manifestSha256: sha256Schema,
  createdAt: z.iso.datetime(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/** The single mapping from a `snapshots` row to `Snapshot`. `t` is the table name or alias. */
export function snapshotJson(t: string) {
  return `json_object('id', ${t}.id, 'ownerId', ${t}.owner_id,
    'formatVersion', ${t}.format_version, 'manifestKey', ${t}.manifest_key,
    'manifestSha256', ${t}.manifest_sha256, 'createdAt', ${t}.created_at)`;
}

const manifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  display: z.strictObject({
    key: z.string().min(1),
    mediaType: z.literal(displayContentType),
    bytes: z.int().nonnegative(),
    sha256: sha256Schema,
  }),
});

function snapshotPrefix(ownerId: string, snapshotId: string) {
  return `owners/${ownerId}/snapshots/${snapshotId}/`;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function writeSnapshot(
  bucket: R2,
  input: { id: string; ownerId: OwnerId; now: string; display: Uint8Array<ArrayBuffer> },
): Promise<Snapshot & { ownerId: OwnerId }> {
  const prefix = snapshotPrefix(input.ownerId, input.id);
  const displayKey = `${prefix}display.mdsp`;
  const manifest = manifestSchema.parse({
    formatVersion: 1,
    display: {
      key: displayKey,
      mediaType: displayContentType,
      bytes: input.display.byteLength,
      sha256: await sha256(input.display),
    },
  });
  await bucket.putNew(displayKey, input.display, displayContentType);
  const manifestBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(manifest)));
  const manifestKey = `${prefix}manifest.json`;
  await bucket.putNew(manifestKey, manifestBytes, "application/json");
  return {
    id: input.id,
    ownerId: input.ownerId,
    formatVersion: 1,
    manifestKey,
    manifestSha256: await sha256(manifestBytes),
    createdAt: input.now,
  };
}

export async function readSnapshotDisplay(bucket: R2, snapshot: Snapshot) {
  const prefix = snapshotPrefix(snapshot.ownerId, snapshot.id);
  if (snapshot.manifestKey !== `${prefix}manifest.json`)
    throw new StorageCorruption("snapshot key");
  const object = await bucket.read(snapshot.manifestKey);
  if (object === null) throw new StorageCorruption("manifest");
  const manifestBytes = object.bytes;
  if ((await sha256(manifestBytes)) !== snapshot.manifestSha256)
    throw new StorageCorruption("manifest hash");
  const manifest = parseJsonColumn(
    new TextDecoder().decode(manifestBytes),
    manifestSchema,
    "manifest",
  );
  if (manifest.display.key !== `${prefix}display.mdsp`) throw new StorageCorruption("display key");
  const display = await bucket.read(manifest.display.key);
  if (display === null) throw new StorageCorruption("display");
  const bytes = display.bytes;
  if (
    bytes.byteLength !== manifest.display.bytes ||
    (await sha256(bytes)) !== manifest.display.sha256
  ) {
    throw new StorageCorruption("display hash");
  }
  return { bytes, contentType: manifest.display.mediaType };
}
