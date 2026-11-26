import { readJobExecutionRight } from "./job-execution.ts";
import type { JobExecutionRight } from "./job-execution.ts";
import type { R2 } from "./r2.ts";
import { displayContentType, elementIdSchema, floorPlanContentType } from "@madori/contracts";
import { z } from "zod";
import { parseJsonColumn, StorageCorruption } from "./rows.ts";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const snapshotFormatVersions = [1, 2] as const;
export const snapshotSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  formatVersion: z.literal(snapshotFormatVersions),
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

function fileSchema<M extends string>(mediaType: M) {
  return z.strictObject({
    key: z.string().min(1),
    mediaType: z.literal(mediaType),
    bytes: z.int().nonnegative(),
    sha256: sha256Schema,
  });
}

const displayFile = fileSchema(displayContentType);
const jsonFile = fileSchema("application/json");
const floorPlan = fileSchema(floorPlanContentType).extend({ storey: elementIdSchema });
const manifestSchema = z.discriminatedUnion("formatVersion", [
  z.strictObject({ formatVersion: z.literal(1), display: displayFile }),
  z.strictObject({
    formatVersion: z.literal(2),
    house: jsonFile,
    display: displayFile,
    floorPlans: z
      .array(floorPlan)
      .min(1)
      .refine(
        (plans) => new Set(plans.map((p) => p.storey)).size === plans.length,
        "duplicate storey",
      ),
    checks: jsonFile,
  }),
]);

const fileNames = {
  manifest: "manifest.json",
  display: "display.mdsp",
  house: "house.json",
  checks: "checks.json",
  floorPlan: (index: number) => `floor-plans/${index}.svg`,
};

function snapshotKey(ownerId: string, snapshotId: string, name: string) {
  return `owners/${ownerId}/snapshots/${snapshotId}/${name}`;
}

const storedHouseSchema = z.object({
  version: z.literal(1),
  house: z.object({
    vertices: z.array(
      z.object({ id: elementIdSchema, at: z.object({ x: z.number(), y: z.number() }) }),
    ),
    boundaries: z.array(
      z.object({
        id: elementIdSchema,
        start: elementIdSchema,
        end: elementIdSchema,
        wall: z.object({
          offsets: z.object({ left: z.number(), right: z.number() }),
          height: z.number(),
        }),
      }),
    ),
    rooms: z.array(
      z.object({
        id: elementIdSchema,
        name: z.string(),
        usage: z.string(),
        edges: z.array(
          z.object({ boundary: elementIdSchema, direction: z.enum(["forward", "reverse"]) }),
        ),
      }),
    ),
    openings: z.array(
      z.object({
        id: elementIdSchema,
        wall: elementIdSchema,
        width: z.number(),
        height: z.number(),
        sill: z.number(),
        fitting: z.object({ kind: z.enum(["window", "door"]) }),
      }),
    ),
  }),
});
export type StoredHouse = z.infer<typeof storedHouseSchema>["house"];

export function parseStoredHouse(text: string): StoredHouse {
  return parseJsonColumn(text, storedHouseSchema, "house").house;
}

type Bytes = Uint8Array<ArrayBuffer>;
export interface HouseFiles<F, Plan = F> {
  data: F;
  floorPlans: readonly ({ storey: string } & Plan)[];
  checks: F;
}
export type SnapshotFile = { contentType: string; read(): Promise<Bytes> };
export type OpenedSnapshot = {
  display: SnapshotFile;
  house: (HouseFiles<SnapshotFile> & { readHouse(): Promise<StoredHouse> }) | null;
};

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function writeSnapshot(
  bucket: R2,
  right: JobExecutionRight,
  input: {
    id: string;
    now: string;
    display: Bytes;
    house?: HouseFiles<Bytes, { svg: Bytes }>;
  },
): Promise<Snapshot> {
  const { ownerId, jobId, generation } = readJobExecutionRight(right);
  const { id, now, house } = input;
  const files: { key: string; bytes: Bytes; mediaType: string }[] = [];
  async function file(name: string, mediaType: string, source: Bytes) {
    const key = snapshotKey(ownerId, id, name);
    const bytes = source.slice();
    files.push({ key, bytes, mediaType });
    return { key, mediaType, bytes: bytes.byteLength, sha256: await sha256(bytes) };
  }
  const display = await file(fileNames.display, displayContentType, input.display);
  const manifest = manifestSchema.parse(
    house === undefined
      ? { formatVersion: 1, display }
      : {
          formatVersion: 2,
          house: await file(fileNames.house, "application/json", house.data),
          display,
          floorPlans: await Promise.all(
            house.floorPlans.map(async ({ storey, svg }, index) => ({
              storey,
              ...(await file(fileNames.floorPlan(index), floorPlanContentType, svg)),
            })),
          ),
          checks: await file(fileNames.checks, "application/json", house.checks),
        },
  );
  await Promise.all(files.map(({ key, bytes, mediaType }) => bucket.putNew(key, bytes, mediaType)));
  const manifestBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(manifest)));
  const manifestKey = snapshotKey(ownerId, id, fileNames.manifest);
  const manifestSha256 = await sha256(manifestBytes);
  await bucket.putNew(manifestKey, manifestBytes, "application/json", {
    customMetadata: { jobId, generation: String(generation) },
    sha256: manifestSha256,
  });
  return {
    id,
    ownerId,
    formatVersion: manifest.formatVersion,
    manifestKey,
    manifestSha256,
    createdAt: now,
  };
}

export async function verifyJobSnapshot(bucket: R2, right: JobExecutionRight, input: Snapshot) {
  const { ownerId, jobId, generation } = readJobExecutionRight(right);
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  const key = snapshotKey(ownerId, snapshot.id, fileNames.manifest);
  if (snapshot.ownerId !== ownerId || snapshot.manifestKey !== key) return null;
  const object = await bucket.head(key);
  if (
    object === null ||
    object.customMetadata.jobId !== jobId ||
    object.customMetadata.generation !== String(generation) ||
    object.sha256 !== snapshot.manifestSha256
  )
    return null;
  return snapshot;
}

export async function openSnapshot(bucket: R2, snapshot: Snapshot): Promise<OpenedSnapshot> {
  const key = (name: string) => snapshotKey(snapshot.ownerId, snapshot.id, name);
  if (snapshot.manifestKey !== key(fileNames.manifest)) throw new StorageCorruption("snapshot key");
  const object = await bucket.read(snapshot.manifestKey);
  if (object === null) throw new StorageCorruption("manifest missing");
  const manifestBytes = object.bytes;
  if ((await sha256(manifestBytes)) !== snapshot.manifestSha256)
    throw new StorageCorruption("manifest hash");
  const manifest = parseJsonColumn(
    new TextDecoder().decode(manifestBytes),
    manifestSchema,
    "manifest",
  );
  if (manifest.formatVersion !== snapshot.formatVersion)
    throw new StorageCorruption("manifest version");
  function openFile(
    name: string,
    entry: { key: string; bytes: number; sha256: string; mediaType: string },
  ): SnapshotFile {
    if (entry.key !== key(name)) throw new StorageCorruption(`${name} key`);
    return {
      contentType: entry.mediaType,
      async read() {
        const file = await bucket.read(entry.key);
        if (file === null) throw new StorageCorruption(name);
        if (file.bytes.byteLength !== entry.bytes || (await sha256(file.bytes)) !== entry.sha256)
          throw new StorageCorruption(`${name} hash`);
        return file.bytes;
      },
    };
  }
  const display = openFile(fileNames.display, manifest.display);
  if (manifest.formatVersion === 1) return { display, house: null };
  const data = openFile(fileNames.house, manifest.house);
  return {
    display,
    house: {
      data,
      async readHouse() {
        return parseStoredHouse(new TextDecoder().decode(await data.read()));
      },
      floorPlans: manifest.floorPlans.map((plan, index) => ({
        ...openFile(fileNames.floorPlan(index), plan),
        storey: plan.storey,
      })),
      checks: openFile(fileNames.checks, manifest.checks),
    },
  };
}
