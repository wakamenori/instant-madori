import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { Revision } from "@madori/contracts";
import {
  acceptInstructionResponseSchema,
  createProjectResponseSchema,
  revisionListResponseSchema,
} from "@madori/contracts";
import { settleJobs } from "./support/settle-jobs.ts";
import { geometryInternal } from "@madori/contracts/geometry-internal";
import { startLocalWorker, newUser } from "./support/local-worker.ts";
const docker = promisify(execFile);
async function runningContainers() {
  const { stdout } = await docker("docker", [
    "ps",
    "--no-trunc",
    "--format",
    "{{.ID}}\t{{.Image}}",
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, image] = line.split("\t");
      assert(id && image, `Invalid docker ps row: ${line}`);
      return { id, image };
    });
}
void test(
  "real Linux container returns an artifact over Worker and DO RPC",
  { timeout: 1_200_000 },
  async (t) => {
    const started = performance.now();
    const idleTimeoutMs = 60_000;
    const worker = await startLocalWorker({
      containers: true,
      readyTimeoutMs: 800_000,
      vars: { GEOMETRY_IDLE_TIMEOUT_MS: String(idleTimeoutMs) },
    });
    const bootMs = performance.now() - started;
    try {
      const viewer = await import("../../../crates/viewer/pkg/madori_viewer.js");
      await viewer.default({
        module_or_path: await readFile(
          new URL("../../../crates/viewer/pkg/madori_viewer_bg.wasm", import.meta.url),
        ),
      });
      assert.equal((await worker.call("/api/sample/display")).status, 401);
      const user = newUser("container");
      for (const start of ["cold", "warm"]) {
        const requested = performance.now();
        const response = await worker.call("/api/sample/display", { as: user });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("content-type"), geometryInternal.displayContentType);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const requestMs = performance.now() - requested;
        const summary = viewer.describe_display(bytes);
        assert.equal(summary.format_version, 1);
        assert.equal(summary.bodies, 4);
        assert.deepEqual(summary.elements, [
          "sample:slab",
          "sample:wall-north",
          "sample:wall-west",
          "sample:wall-east",
        ]);
        summary.free();
        const log = await worker.logLine(response.headers.get("x-trace-id") ?? "");
        assert.equal(log["geometryStart"], start);
        if (start === "cold") {
          for (const [event, keys] of [
            ["container.started", ["level", "event", "traceId", "image"]],
            ["container.ready", ["level", "event", "traceId", "mode", "ms"]],
          ] as const) {
            const entry = await worker.logLine(response.headers.get("x-trace-id") ?? "", event);
            assert.deepEqual(Object.keys(entry).sort(), [...keys].sort());
            assert.equal(entry["level"], "info");
          }
        }
        console.info(
          JSON.stringify({
            environment: "local Docker amd64 emulation",
            start,
            bootMs,
            requestMs,
            bytes: bytes.byteLength,
            gatewayMs: log["geometryMs"],
          }),
        );
      }
      assert.equal(
        worker.logEntries().filter((entry) => entry["event"] === "container.started").length,
        1,
      );
      await t.test(
        "idle alarm stops this session's Container and the next request starts cold",
        async () => {
          const started = worker
            .logEntries()
            .find((entry) => entry["event"] === "container.started");
          assert(started);
          const owned = (await runningContainers()).filter(
            (entry) => entry.image === started["image"],
          );
          assert.equal(
            owned.length,
            1,
            "container.started image identifies exactly this Worker session",
          );
          const id = owned[0]?.id;
          assert(id);
          const waited = performance.now();
          const deadline = waited + idleTimeoutMs + 30_000;
          let stopped;
          while (performance.now() < deadline) {
            stopped = worker
              .logEntries()
              .find((entry) => entry["event"] === "container.idle_stopped");
            if (stopped) break;
            await setTimeout(200);
          }
          assert(stopped, "the DO must log container.idle_stopped, not just lose the Container");
          assert.equal(stopped["level"], "info");
          assert(typeof stopped["ms"] === "number" && stopped["ms"] >= idleTimeoutMs);
          assert(
            !(await runningContainers()).some((entry) => entry.id === id),
            "the owned Container stopped",
          );
          const response = await worker.call("/api/sample/display", { as: user });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          const log = await worker.logLine(response.headers.get("x-trace-id") ?? "");
          assert.equal(log["geometryStart"], "cold");
          assert.equal(
            worker.logEntries().filter((entry) => entry["event"] === "container.started").length,
            2,
          );
          console.info(
            JSON.stringify({
              event: "container.idle_verified",
              idleMs: stopped["ms"],
              observedMs: performance.now() - waited,
              containerId: id,
              nextStart: log["geometryStart"],
            }),
          );
        },
      );
      await t.test(
        "jobs commit immutable sample revisions through each pattern's Container",
        async () => {
          const created = await worker.call("/api/projects", {
            method: "POST",
            as: user,
            body: { requestId: crypto.randomUUID() },
          });
          assert.equal(created.status, 201);
          const { pattern } = createProjectResponseSchema.parse(await created.json());
          const revisions: Revision[] = [];
          for (let i = 0; i < 2; i++) {
            const response = await worker.call(`/api/patterns/${pattern.id}/messages`, {
              method: "POST",
              as: user,
              body: { requestId: crypto.randomUUID(), body: "サンプルを作って" },
            });
            assert.equal(response.status, 202);
            const { job } = acceptInstructionResponseSchema.parse(await response.json());
            const state = await settleJobs(worker, user, pattern.id, [job.jobId], 300_000);
            const revision = state.currentRevision;
            assert(revision);
            assert.equal(revision.baseRevisionId, revisions[0]?.id ?? null);
            const finished = await worker.logLine(job.jobId, "job.finished");
            assert.equal(finished["outcome"], "committed");
            assert.equal(finished["revisionId"], revision.id);
            if (i === 0) {
              await worker.logLine(job.jobId, "container.started");
              await worker.logLine(job.jobId, "container.ready");
            }
            const view = await worker.call(`/api/revisions/${revision.id}/view`, { as: user });
            assert.equal(view.status, 200);
            const summary = viewer.describe_display(new Uint8Array(await view.arrayBuffer()));
            assert.equal(summary.format_version, 1);
            assert.equal(summary.bodies, 4);
            assert.deepEqual(summary.elements, [
              "sample:slab",
              "sample:wall-north",
              "sample:wall-west",
              "sample:wall-east",
            ]);
            summary.free();
            revisions.unshift(revision);
          }
          const history = await worker.call(`/api/patterns/${pattern.id}/revisions`, { as: user });
          assert.equal(history.status, 200);
          assert.deepEqual(revisionListResponseSchema.parse(await history.json()), {
            revisions,
            nextCursor: null,
          });
        },
      );
    } finally {
      await worker.stop();
    }
  },
);
