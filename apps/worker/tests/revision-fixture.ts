import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LocalWorker } from "./support/local-worker.ts";

const execFileAsync = promisify(execFile);
export async function revisionFixture(worker: LocalWorker, input: unknown): Promise<unknown> {
  return worker.withPausedWorker(async (state) => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        fileURLToPath(new URL("./rpc/revision-fixture.ts", import.meta.url)),
        state,
        JSON.stringify(input),
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    const last = stdout.trim().split("\n").at(-1);
    assert(last);
    const result: unknown = JSON.parse(last);
    return result;
  });
}
