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
  stopJobResponseSchema,
  patternStateResponseSchema,
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
    '{{.ID}}\t{{.Image}}\t{{.Label "dev.workerd.session"}}',
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, image, session = ""] = line.split("\t");
      assert(id && image, `Invalid docker ps row: ${line}`);
      return { id, image, session };
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
      vars: {
        GEOMETRY_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
        // Local workerd evicts a DO 10 s after its last call closes, so with this hold a job
        // reaches a fresh DO only if the previous job's DO call closed.
        JOB_TEST_HOLD: "before_commit:15",
      },
    });
    const bootMs = performance.now() - started;
    let session: string | undefined;
    try {
      const preexistingIds = new Set((await runningContainers()).map(({ id }) => id));
      const viewer = await import("../../../crates/viewer/pkg/madori_viewer.js");
      await viewer.default({
        module_or_path: await readFile(
          new URL("../../../crates/viewer/pkg/madori_viewer_bg.wasm", import.meta.url),
        ),
      });
      const user = newUser("container");
      const created = await worker.call("/api/projects", {
        method: "POST",
        as: user,
        body: { requestId: crypto.randomUUID() },
      });
      assert.equal(created.status, 201);
      const { pattern } = createProjectResponseSchema.parse(await created.json());
      const revisions: Revision[] = [];
      const jobIds: string[] = [];
      async function accept() {
        const response = await worker.call(`/api/patterns/${pattern.id}/messages`, {
          method: "POST",
          as: user,
          body: { requestId: crypto.randomUUID(), body: "次の案を作って" },
        });
        assert.equal(response.status, 202);
        const { job } = acceptInstructionResponseSchema.parse(await response.json());
        jobIds.push(job.jobId);
        return job;
      }
      async function commitAndView(start: "cold" | "warm") {
        const requested = performance.now();
        const job = await accept();
        const state = await settleJobs(worker, user, pattern.id, [job.jobId], 300_000);
        const jobMs = performance.now() - requested;
        const revision = state.currentRevision;
        assert(revision);
        assert.equal(revision.baseRevisionId, revisions[0]?.id ?? null);
        assert.equal(revision.number, revisions.length + 1);
        const finished = await worker.logLine(job.jobId, "job.finished");
        assert.equal(finished["outcome"], "committed");
        assert.equal(finished["revisionId"], revision.id);
        revisions.unshift(revision);
        const viewPath = `/api/revisions/${revision.id}/view`;
        assert.equal((await worker.call(viewPath)).status, 401);
        const response = await worker.call(viewPath, { as: user });
        assert.equal(response.headers.get("x-revision-id"), revision.id);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("content-type"), geometryInternal.displayContentType);
        const bytes = new Uint8Array(await response.arrayBuffer());
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
        if (start === "cold") {
          for (const [event, keys] of [
            ["container.started", ["level", "event", "traceId", "image"]],
            ["container.ready", ["level", "event", "traceId", "mode", "ms"]],
          ] as const) {
            const entry = await worker.logLine(job.jobId, event);
            assert.deepEqual(Object.keys(entry).sort(), [...keys].sort());
            assert.equal(entry["level"], "info");
          }
        } else {
          assert(
            !worker
              .logEntries()
              .some(
                (entry) => entry["event"] === "container.started" && entry["traceId"] === job.jobId,
              ),
            "warm job reuses the pattern Container",
          );
        }
        console.info(
          JSON.stringify({
            environment: "local Docker amd64 emulation",
            start,
            bootMs,
            jobMs,
            bytes: bytes.byteLength,
          }),
        );
      }
      await commitAndView("cold");
      const image = worker.logEntries().find((entry) => entry["event"] === "container.started")?.[
        "image"
      ];
      assert.equal(typeof image, "string");
      const sessions = new Set(
        (await runningContainers())
          .filter((entry) => entry.image === image)
          .map((entry) => entry.session),
      );
      assert.equal(sessions.size, 1);
      [session] = sessions;
      assert(session);
      assert.match(session, /^[0-9a-f]{16}$/);
      await commitAndView("warm");
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
          await commitAndView("cold");
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
              nextStart: "cold",
            }),
          );
        },
      );
      await t.test("stopped during the hold, the commit is refused", async () => {
        const current = revisions[0];
        assert(current);
        const beforeView = await worker.call(`/api/revisions/${current.id}/view`, { as: user });
        assert.equal(beforeView.status, 200);
        const bytes = new Uint8Array(await beforeView.arrayBuffer());
        const job = await accept();
        const deadline = Date.now() + 120_000;
        let held: boolean;
        do {
          held = worker
            .logEntries()
            .some(
              (line) =>
                line["jobId"] === job.jobId &&
                line["event"] === "job.step" &&
                line["step"] === "check test hold before commit" &&
                line["outcome"] === "hold",
            );
          if (held) break;
          await setTimeout(50);
        } while (Date.now() < deadline);
        assert(held, "the job saved R2 data and reached the durable hold");
        assert(
          worker
            .logEntries()
            .some(
              (line) =>
                line["jobId"] === job.jobId &&
                line["step"] === "render snapshot" &&
                line["outcome"] === "saved",
            ),
        );
        const response = await worker.call(`/api/jobs/${job.jobId}/stop`, {
          method: "POST",
          as: user,
          body: { requestId: crypto.randomUUID() },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(stopJobResponseSchema.parse(await response.json()), {
          outcome: "stopped",
          job: { ...job, state: "cancelled" },
        });
        const state = await settleJobs(worker, user, pattern.id, [job.jobId], 60_000);
        assert.deepEqual(state.currentRevision, current);
        assert.deepEqual(state.lastFinishedJob, { ...job, state: "cancelled" });
        const finished = await worker.logLine(job.jobId, "job.finished");
        assert.equal(finished["level"], "info");
        assert.equal(finished["outcome"], "cancelled");
        assert(
          worker
            .logEntries()
            .some(
              (line) =>
                line["jobId"] === job.jobId &&
                line["step"] === "commit revision" &&
                line["outcome"] === "cancelled",
            ),
        );
        const history = await worker.call(`/api/patterns/${pattern.id}/revisions`, {
          as: user,
        });
        assert.deepEqual(revisionListResponseSchema.parse(await history.json()), {
          revisions,
          nextCursor: null,
        });
        const afterView = await worker.call(`/api/revisions/${current.id}/view`, { as: user });
        assert.equal(afterView.status, 200);
        assert.deepEqual(new Uint8Array(await afterView.arrayBuffer()), bytes);
      });
      await t.test("completion first keeps its committed revision in stop and state", async () => {
        const job = await accept();
        const state = await settleJobs(worker, user, pattern.id, [job.jobId], 120_000);
        const revision = state.currentRevision;
        assert(revision);
        assert.equal(revision.number, 4);
        assert.equal(revision.baseRevisionId, revisions[0]?.id);
        revisions.unshift(revision);
        const requestId = crypto.randomUUID();
        const stop = () =>
          worker.call(`/api/jobs/${job.jobId}/stop`, {
            method: "POST",
            as: user,
            body: { requestId },
          });
        const response = await stop();
        assert.equal(response.status, 200);
        const text = await response.text();
        const expected = { ...job, state: "completed", revision };
        assert.deepEqual(stopJobResponseSchema.parse(JSON.parse(text)), {
          outcome: "already_finished",
          job: expected,
        });
        assert.equal(await (await stop()).text(), text);
        const responseState = await worker.call(`/api/patterns/${pattern.id}/state`, {
          as: user,
        });
        const after = patternStateResponseSchema.parse(await responseState.json());
        assert.deepEqual(after.currentRevision, revision);
        assert.deepEqual(after.lastFinishedJob, expected);
      });
      await t.test("no job reached a DO kept alive by the previous job's call", () => {
        const modes = jobIds.map(
          (id) =>
            worker
              .logEntries()
              .find((e) => e["event"] === "container.ready" && e["traceId"] === id)?.["mode"] ??
            "reused a live DO",
        );
        assert.deepEqual(modes, ["cold", "adopted", "cold", "adopted", "adopted"]);
      });
      await t.test(
        "a Container killed outside the gateway is replaced by the next job",
        async () => {
          const created = await worker.call("/api/projects", {
            method: "POST",
            as: user,
            body: { requestId: crypto.randomUUID() },
          });
          assert.equal(created.status, 201);
          const { pattern: ownPattern } = createProjectResponseSchema.parse(await created.json());
          const image = worker.logEntries().find((e) => e["event"] === "container.started")?.[
            "image"
          ];
          assert.equal(typeof image, "string");
          const sessionContainers = async () =>
            (await runningContainers()).filter((container) => container.image === image);
          const before = new Set((await sessionContainers()).map(({ id }) => id));
          async function runJob() {
            const accepted = await worker.call(`/api/patterns/${ownPattern.id}/messages`, {
              method: "POST",
              as: user,
              body: { requestId: crypto.randomUUID(), body: "次の案を作って" },
            });
            assert.equal(accepted.status, 202);
            const { job } = acceptInstructionResponseSchema.parse(await accepted.json());
            await settleJobs(worker, user, ownPattern.id, [job.jobId], 300_000);
            const started = await worker.logLine(job.jobId, "container.started");
            assert.equal(started["image"], image);
            assert.equal((await worker.logLine(job.jobId, "job.finished"))["outcome"], "committed");
            assert.deepEqual(
              worker
                .logEntries()
                .filter(
                  (e) =>
                    e["jobId"] === job.jobId &&
                    e["event"] === "job.step" &&
                    e["step"] === "render snapshot",
                )
                .map((e) => [e["attempt"], e["outcome"]]),
              [[1, "saved"]],
              "the first render attempt reached a working Container and no retry hid a failed one",
            );
            return job;
          }
          const first = await runJob();
          await worker.logLine(first.jobId, "container.ready");
          const added = (await sessionContainers()).filter(
            ({ id }) => !before.has(id) && !preexistingIds.has(id),
          );
          assert.equal(added.length, 1, "the first job started one new Container");
          const target = added[0];
          assert(target);
          await docker("docker", ["kill", target.id]);

          await runJob();
          const history = await worker.call(`/api/patterns/${ownPattern.id}/revisions`, {
            as: user,
          });
          assert.equal(history.status, 200);
          assert.equal(revisionListResponseSchema.parse(await history.json()).revisions.length, 2);
        },
      );
      const history = await worker.call(`/api/patterns/${pattern.id}/revisions`, { as: user });
      assert.equal(history.status, 200);
      assert.deepEqual(revisionListResponseSchema.parse(await history.json()), {
        revisions,
        nextCursor: null,
      });
    } finally {
      await worker.stop();
    }
    assert(session);
    const filter = `label=dev.workerd.session=${session}`;
    await t.test("stopping the Worker removes every container of its session", async () => {
      const deadline = performance.now() + 30_000;
      let remaining: string;
      do {
        const { stdout } = await docker("docker", [
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          filter,
        ]);
        remaining = stdout.trim();
        if (!remaining) break;
        await setTimeout(250);
      } while (performance.now() < deadline);
      assert.equal(remaining, "", `containers remain for ${filter}`);
    });
  },
);
