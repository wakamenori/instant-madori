import { readJobExecutionRight, type JobExecutionRight } from "./job-execution.ts";
import { StorageCorruption } from "./rows.ts";
import { sha256 } from "./snapshots.ts";
import type { R2 } from "./r2.ts";

export type JobWorkPath = "prefix.json" | `rounds/${number}.json`;

export function jobWork(bucket: R2) {
  function address(right: JobExecutionRight, path: JobWorkPath) {
    const { ownerId, jobId, generation } = readJobExecutionRight(right);
    return {
      key: `owners/${ownerId}/jobs/${jobId}/g${generation}/${path}`,
      customMetadata: { jobId, generation: String(generation) },
    };
  }
  async function read(right: JobExecutionRight, path: JobWorkPath, expected?: string) {
    const { key, customMetadata } = address(right, path);
    const head = await bucket.head(key);
    if (!head) return null;
    const object = await bucket.read(key);
    if (
      !object ||
      head.sha256 === null ||
      (expected !== undefined && head.sha256 !== expected) ||
      head.customMetadata.jobId !== customMetadata.jobId ||
      head.customMetadata.generation !== customMetadata.generation ||
      (await sha256(object.bytes)) !== head.sha256
    )
      throw new StorageCorruption("job work");
    return { ref: { path, sha256: head.sha256 }, text: new TextDecoder().decode(object.bytes) };
  }
  return {
    read,
    async keep(right: JobExecutionRight, path: JobWorkPath, text: string) {
      const { key, customMetadata } = address(right, path);
      const bytes = new Uint8Array(new TextEncoder().encode(text));
      const digest = await sha256(bytes);
      try {
        await bucket.putNew(key, bytes, "application/json", { customMetadata, sha256: digest });
      } catch (error) {
        const winner = await read(right, path);
        if (winner) return winner;
        throw error;
      }
      return { ref: { path, sha256: digest }, text };
    },
  };
}
