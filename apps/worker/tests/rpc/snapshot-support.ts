import type { JobWorkflowDeps } from "../../src/services/deps.ts";
import { sha256 } from "../../src/storage/snapshots.ts";
import { displayContentType } from "@madori/contracts";
import { readJobExecutionRight, type JobExecutionRight } from "../../src/storage/job-execution.ts";
const bytes = (s: string) => new Uint8Array(new TextEncoder().encode(s));
export const fixtureHouse = {
  data: bytes('{"version":1,"house":{"rooms":[],"boundaries":[],"openings":[],"vertices":[]}}'),
  checks: bytes('{"housing":[],"model":[]}'),
  floorPlans: [{ storey: "s1", svg: bytes("<svg/>") }],
};
export async function saveJobSnapshot(
  { store, runtime }: Pick<JobWorkflowDeps, "store" | "runtime">,
  input: { right: JobExecutionRight; display: Uint8Array<ArrayBuffer> },
) {
  const status = await store.jobs.check(input.right);
  if (status.kind !== "active") return status;
  const snapshot = await store.snapshots.write(input.right, {
    id: runtime.newId(),
    now: runtime.now(),
    display: input.display,
    house: fixtureHouse,
  });
  return { kind: "saved" as const, snapshot };
}

export async function legacySnapshot(
  bucket: R2Bucket,
  right: JobExecutionRight,
  display: Uint8Array<ArrayBuffer>,
  now: string,
) {
  const { ownerId, jobId, generation } = readJobExecutionRight(right);
  const id = crypto.randomUUID();
  const prefix = `owners/${ownerId}/snapshots/${id}/`;
  const key = prefix + "display.mdsp";
  const manifest = JSON.stringify({
    formatVersion: 1,
    display: {
      key,
      mediaType: displayContentType,
      bytes: display.length,
      sha256: await sha256(display),
    },
  });
  const manifestKey = prefix + "manifest.json";
  const manifestSha256 = await sha256(bytes(manifest));
  await bucket.put(key, display);
  await bucket.put(manifestKey, manifest, {
    customMetadata: { jobId, generation: String(generation) },
    sha256: manifestSha256,
  });
  return { id, ownerId, formatVersion: 1 as const, manifestKey, manifestSha256, createdAt: now };
}
