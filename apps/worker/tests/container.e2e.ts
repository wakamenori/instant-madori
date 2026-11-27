import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { test } from "node:test";
import type { Revision } from "@madori/contracts";
import {
  acceptInstructionResponseSchema,
  createProjectResponseSchema,
  messageListResponseSchema,
  revisionListResponseSchema,
  stopJobResponseSchema,
  patternStateResponseSchema,
} from "@madori/contracts";
import { settleJobs } from "./support/settle-jobs.ts";
import { geometryInternal, houseSummarySchema } from "@madori/contracts/geometry-internal";
import { startLocalWorker, newUser, type LocalWorker } from "./support/local-worker.ts";
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

/**
 * Local workerd evicts a DO 10 s after its last call closes. A job starting this
 * long after the previous job's last DO call reaches a fresh DO.
 */
const doEvictionSeconds = 15;
const idleTimeoutMs = 60_000;

function bootWorker(hold: `finish_answer:${number}` | "none") {
  return startLocalWorker({
    containers: true,
    entry: "tests/rpc/geometry-probe.ts",
    readyTimeoutMs: 800_000,
    vars: {
      GEOMETRY_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
      JOB_TEST_HOLD: hold,
    },
  });
}

async function sessionOf(worker: LocalWorker) {
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
  const [session] = sessions;
  assert(session);
  assert.match(session, /^[0-9a-f]{16}$/);
  return session;
}

void test(
  "real Linux container returns an artifact over Worker and DO RPC",
  { timeout: 1_200_000, concurrency: true },
  async (t) => {
    const started = performance.now();
    const main = await bootWorker(`finish_answer:${doEvictionSeconds}`);
    t.after(() => main.stop());
    const bootMs = performance.now() - started;
    const preexistingIds = new Set((await runningContainers()).map(({ id }) => id));
    const viewer = await import("../../../crates/viewer/pkg/madori_viewer.js");
    await viewer.default({
      module_or_path: await readFile(
        new URL("../../../crates/viewer/pkg/madori_viewer_bg.wasm", import.meta.url),
      ),
    });

    async function runMainLane(worker: LocalWorker) {
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
          body: { requestId: crypto.randomUUID(), body: "台本:plan" },
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
        assert(summary.bodies > 0);
        const elements = new Set(summary.elements);
        assert(elements.size > 0);
        for (const element of elements) {
          const picked = await worker.call(`/api/revisions/${revision.id}/pick`, {
            method: "POST",
            as: user,
            body: { element },
          });
          assert.equal(picked.status, 200, `display element ${element} is in the revision's house`);
        }
        assert(response.headers.get("x-floor-plan-storeys"));
        assert.equal(revision.name, "台本の案");
        const lines = worker
          .logEntries()
          .filter(
            (line) =>
              line["jobId"] === job.jobId &&
              line["event"] === "job.step" &&
              typeof line["aiMs"] === "number",
          );
        assert.equal(lines.length, revision.baseRevisionId === null ? 4 : 2);
        const messages = await worker.call(`/api/patterns/${pattern.id}/messages`, { as: user });
        const page = z
          .object({
            messages: z.array(
              z.object({ kind: z.string(), body: z.string(), jobId: z.string().nullable() }),
            ),
          })
          .parse(await messages.json());
        assert(
          page.messages.some(
            (m) => m.kind === "explanation" && m.jobId === job.jobId && m.body.includes("LDK"),
          ),
        );
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
      const session = await sessionOf(worker);
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
      const question = t.test(
        "asking after an edit discards it and the answer commits before the waiting instruction",
        async () => {
          const created = await worker.call("/api/projects", {
            method: "POST",
            as: user,
            body: { requestId: crypto.randomUUID() },
          });
          const {
            pattern: { id },
          } = createProjectResponseSchema.parse(await created.json());
          const path = `/api/patterns/${id}`;
          async function submit(body: string, questionId?: string) {
            const response = await worker.call(path + "/messages", {
              method: "POST",
              as: user,
              body: { requestId: crypto.randomUUID(), body, questionId },
            });
            assert.equal(response.status, 202);
            return acceptInstructionResponseSchema.parse(await response.json()).job;
          }
          async function state() {
            return patternStateResponseSchema.parse(
              await (await worker.call(path + "/state", { as: user })).json(),
            );
          }
          const asking = await submit("台本:question-after-edit");
          const waiting = await submit("壁の色を変えて");
          assert.equal((await worker.logLine(asking.jobId, "job.finished"))["outcome"], "asked");
          const held = await state();
          const holder = held.queueHold?.job;
          assert(
            holder?.state === "awaiting_answer",
            "the question holds the queue only if the waiting instruction was accepted first",
          );
          assert.equal(held.currentRevision, null, "the provisional edit added no revision");
          const answer = await submit("必要", holder.question.messageId);
          assert.equal(
            (await worker.logLine(answer.jobId, "job.finished"))["outcome"],
            "committed",
          );
          const answered = await state();
          const first = answered.currentRevision;
          assert(first);
          assert.equal(first.number, 1);
          assert.equal(first.baseRevisionId, null);
          assert.equal(answered.queueHold?.job.jobId, asking.jobId);
          assert.deepEqual(answered.queuedJobs, [waiting]);
          const resumed = await worker.call(path + "/queue/resume", {
            as: user,
            method: "POST",
            body: { requestId: crypto.randomUUID(), heldBy: asking.jobId },
          });
          assert.equal(resumed.status, 200);
          const last = (await settleJobs(worker, user, id, [waiting.jobId], 300_000))
            .currentRevision;
          assert.equal(last?.number, 2);
          assert.equal(last.baseRevisionId, first.id);
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
                line["step"] === "round 2 ai" &&
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
                line["step"] === "round 1 call 1 edit_house" &&
                line["outcome"] === "edited",
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
                line["step"] === "round 2 finish" &&
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
      const history = await worker.call(`/api/patterns/${pattern.id}/revisions`, { as: user });
      assert.equal(history.status, 200);
      assert.deepEqual(revisionListResponseSchema.parse(await history.json()), {
        revisions,
        nextCursor: null,
      });
      await question;
      return session;
    }

    async function runSideLane(worker: LocalWorker) {
      const user = newUser("container-side");
      for (const script of ["reject-window", "unresolved"] as const) {
        await t.test(script, async () => {
          const created = await worker.call("/api/projects", {
            as: user,
            method: "POST",
            body: { requestId: crypto.randomUUID() },
          });
          const { pattern: own } = createProjectResponseSchema.parse(await created.json());
          async function send(name: string) {
            const accepted = await worker.call(`/api/patterns/${own.id}/messages`, {
              as: user,
              method: "POST",
              body: { requestId: crypto.randomUUID(), body: "台本:" + name },
            });
            assert.equal(accepted.status, 202);
            return acceptInstructionResponseSchema.parse(await accepted.json()).job;
          }
          const base =
            script === "unresolved"
              ? await settleJobs(worker, user, own.id, [(await send("plan")).jobId], 300000)
              : null;
          const job = await send(script);
          const state = await settleJobs(worker, user, own.id, [job.jobId], 300000, {
            resumeHolds: true,
          });
          const lines = worker
            .logEntries()
            .filter((l) => l["jobId"] === job.jobId && l["event"] === "job.step");
          const end = await worker.logLine(job.jobId, "job.finished");
          if (script === "reject-window") {
            assert.equal(end["outcome"], "committed");
            assert.equal(state.currentRevision?.name, "窓を直した案");
            assert(
              lines.some(
                (l) => l["step"] === "round 3 call 1 edit_house" && l["outcome"] === "refused",
              ),
            );
            assert.equal(lines.filter((l) => typeof l["aiMs"] === "number").length, 6);
          } else {
            assert.equal(end["outcome"], "limited");
            assert.equal(end["limit"], "checkFixes");
            assert.equal(lines.filter((l) => l["outcome"] === "blocked").length, 4);
            assert.deepEqual(state.currentRevision, base?.currentRevision);
            assert.equal(state.lastFinishedJob?.state, "limited");
            const response = await worker.call(`/api/patterns/${own.id}/messages`, { as: user });
            assert.equal(response.status, 200);
            const { messages } = messageListResponseSchema.parse(await response.json());
            assert(
              messages.some((message) => message.jobId === job.jobId && message.kind === "notice"),
            );
            assert(state.currentRevision);
            assert.equal(
              (await worker.call(`/api/revisions/${state.currentRevision.id}/view`, { as: user }))
                .status,
              200,
            );
          }
        });
      }
      const session = await sessionOf(worker);
      async function probe(body: unknown, traceId: string) {
        const response = await worker.call("/api/__probe/operations", {
          method: "POST",
          body: { patternId: `probe-${traceId}`, traceId, body },
        });
        assert.equal(response.status, 200);
        return response.json();
      }
      const base = { job_id: "probe", operation_id: "place", generation: 1 };
      const placement = {
        ...base,
        snapshot: { kind: "empty" },
        operations: [
          {
            kind: "place_rooms",
            layout: {
              walls: { exterior_thickness: 200, interior_thickness: 100, height: 2800 },
              rooms: [
                { name: "room", usage: "living", min: { x: 0, y: 0 }, max: { x: 4000, y: 3000 } },
              ],
            },
          },
        ],
      };
      await t.test("element IDs follow the batch's operation ID", async () => {
        const trace = crypto.randomUUID();
        async function roomIds(operationId: string) {
          const result = await probe({ ...placement, operation_id: operationId }, trace);
          return z
            .object({
              value: z.object({
                operations: z.array(z.object({ rooms: z.array(z.object({ id: z.string() })) })),
              }),
            })
            .parse(result)
            .value.operations.flatMap((o) => o.rooms.map((r) => r.id));
        }
        const first = await roomIds("place");
        assert(first.length > 0);
        assert.deepEqual(await roomIds("place"), first, "the same operation ID gives the same IDs");
        const other = await roomIds("place-again");
        assert(
          other.length === first.length && other.every((id) => !first.includes(id)),
          "another operation ID gives other IDs",
        );
      });
      await t.test("a room placement returns display bodies with housing IDs", async () => {
        const traceId = crypto.randomUUID();
        const result = await probe(placement, traceId);
        const { value } = z
          .object({
            kind: z.literal("ok"),
            value: z.object({
              kind: z.literal("applied"),
              operations: z.array(
                z.object({
                  kind: z.literal("rooms_placed"),
                  rooms: z.array(z.object({ id: z.string() })),
                }),
              ),
              parts: z.array(
                z.object({ artifact: z.object({ kind: z.string() }), bytes: z.string() }),
              ),
            }),
          })
          .parse(result);
        const part = (kind: string) => {
          const p = value.parts.find((p) => p.artifact.kind === kind);
          assert(p);
          return Buffer.from(p.bytes, "base64");
        };
        const ids = z.array(z.object({ id: z.string() }));
        const { house } = z
          .object({ house: z.object({ boundaries: ids, rooms: ids }) })
          .parse(JSON.parse(part("house").toString()));
        const response = await worker.call("/api/__probe/summary", {
          method: "POST",
          body: {
            patternId: `probe-${traceId}`,
            traceId,
            body: { snapshot: { kind: "house", json: part("house").toString() } },
          },
        });
        const plan = z
          .object({ kind: z.literal("ok"), value: houseSummarySchema })
          .parse(await response.json()).value;
        assert.deepEqual(
          plan.rooms.map((r) => r.id),
          house.rooms.map((r) => r.id),
        );
        assert.deepEqual(
          plan.walls.map((w) => w.id),
          house.boundaries.map((w) => w.id),
        );
        const summary = viewer.describe_display(part("display"));
        try {
          assert.deepEqual(
            new Set(summary.elements),
            new Set([...house.boundaries, ...house.rooms].map((e) => e.id)),
          );
          assert.deepEqual(
            value.operations.flatMap((o) => o.rooms.map((r) => r.id)),
            house.rooms.map((r) => r.id),
          );
        } finally {
          summary.free();
        }
      });
      await t.test("oversize requests never start the probe Container", async () => {
        const trace = crypto.randomUUID();
        const limit = geometryInternal.routes.applyOperations.request.max_bytes;
        const body = {
          ...base,
          snapshot: { kind: "house", json: "x".repeat(limit) },
          operations: [],
        };
        assert.deepEqual(await probe(body, trace), {
          kind: "failed",
          reason: "request_too_large",
          bytes: Buffer.byteLength(JSON.stringify(body)),
          limit,
        });
        assert(
          !worker
            .logEntries()
            .some((entry) => entry["event"] === "container.ready" && entry["traceId"] === trace),
        );
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
              body: { requestId: crypto.randomUUID(), body: "台本:plan" },
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
                    e["step"] === "round 1 call 1 edit_house",
                )
                .map((e) => [e["attempt"], e["outcome"]]),
              [[1, "edited"]],
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
          await docker("docker", ["wait", target.id]);

          await runJob();
          const history = await worker.call(`/api/patterns/${ownPattern.id}/revisions`, {
            as: user,
          });
          assert.equal(history.status, 200);
          assert.equal(revisionListResponseSchema.parse(await history.json()).revisions.length, 2);
        },
      );
      return session;
    }

    async function startSideLane() {
      const worker = await bootWorker("none");
      t.after(() => worker.stop());
      try {
        return await runSideLane(worker);
      } finally {
        await worker.stop();
      }
    }

    const lanes = await Promise.allSettled([runMainLane(main), startSideLane()]);
    await main.stop();

    const sessions: string[] = [];
    const errors: unknown[] = [];
    for (const lane of lanes) {
      if (lane.status === "fulfilled") sessions.push(lane.value);
      else errors.push(lane.reason);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Container test lanes failed");

    await t.test("stopping the Worker removes every container of its session", async () => {
      for (const session of sessions) {
        const filter = `label=dev.workerd.session=${session}`;
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
      }
    });
  },
);
