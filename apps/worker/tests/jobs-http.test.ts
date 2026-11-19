import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  acceptInstructionResponseSchema,
  accessAssertionHeader,
  apiErrorSchema,
  createProjectResponseSchema,
  patternStateResponseSchema,
  revisionListResponseSchema,
} from "@madori/contracts";
import type { AcceptInstructionRequest } from "@madori/contracts";
import { signAccessToken } from "../../../scripts/dev/local-access.ts";
import { newUser, startLocalWorker, testAppOrigin } from "./support/local-worker.ts";
import { settleJobs } from "./support/settle-jobs.ts";

const execFileAsync = promisify(execFile);

await test("Instruction acceptance through workerd and local D1", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());
  const owner = newUser("instruction-owner");
  const other = newUser("instruction-other");
  const marker = "private-instruction-marker-36";
  const create = async () => {
    const response = await worker.call("/api/projects", {
      method: "POST",
      as: owner,
      body: { requestId: crypto.randomUUID() },
    });
    assert.equal(response.status, 201);
    return createProjectResponseSchema.parse(await response.json()).pattern;
  };
  const pattern = await create();
  const path = `/api/patterns/${pattern.id}/messages`;
  const statePath = `/api/patterns/${pattern.id}/state`;
  const requestId = crypto.randomUUID();
  const body = { requestId, body: ` \t${marker} 間取りを作って\n\u3000` };
  const send = (input: AcceptInstructionRequest = body, target = path) =>
    worker.call(target, { method: "POST", as: owner, body: input });
  const error = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status);
    assert.deepEqual(apiErrorSchema.parse(await response.json()), { error: code });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert(response.headers.get("x-trace-id"));
  };
  const token = await signAccessToken(worker.key, owner);
  const raw = (target: string, text: string | Uint8Array<ArrayBuffer>, headers = {}) =>
    fetch(`${worker.origin}${target}`, {
      method: "POST",
      headers: {
        origin: testAppOrigin,
        "content-type": "application/json",
        [accessAssertionHeader]: token,
        ...headers,
      },
      body: text,
    });
  const state = async () => {
    const response = await worker.call(statePath, { as: owner });
    assert.equal(response.status, 200);
    return patternStateResponseSchema.parse(await response.json());
  };

  await t.test("authentication, Origin and ownership protect acceptance and reads", async () => {
    await error(await worker.call(path, { method: "POST", body }), 401, "unauthenticated");
    await error(
      await raw(path, JSON.stringify(body), { [accessAssertionHeader]: "invalid" }),
      401,
      "unauthenticated",
    );
    for (const origin of ["https://untrusted.test", null]) {
      await error(
        await worker.call(path, { method: "POST", as: owner, origin, body }),
        403,
        "forbidden",
      );
    }
    await error(await worker.call(path, { method: "POST", as: other, body }), 404, "not_found");
    await error(
      await send(body, `/api/patterns/${crypto.randomUUID()}/messages`),
      404,
      "not_found",
    );
    await error(await worker.call(statePath, { as: other }), 404, "not_found");
    await error(await worker.call(statePath), 401, "unauthenticated");
    assert.deepEqual((await state()).queuedJobs, []);
  });

  const first = await send();
  assert.equal(first.status, 202);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const firstText = await first.text();
  const accepted = acceptInstructionResponseSchema.parse(JSON.parse(firstText));
  assert.deepEqual(JSON.parse(firstText), { job: accepted.job });
  assert.deepEqual(Object.keys(accepted.job).sort(), ["jobId", "messageId", "number"]);
  assert.equal(accepted.job.number, 1);

  await t.test(
    "resends keep the exact receipt and logs distinguish applied from replayed",
    async () => {
      const replay = await send({ ...body, requestId: requestId.toUpperCase() });
      assert.equal(replay.status, 202);
      assert.equal(await replay.text(), firstText);
      const firstTrace = first.headers.get("x-trace-id");
      const replayTrace = replay.headers.get("x-trace-id");
      assert(firstTrace && replayTrace);
      assert.notEqual(firstTrace, replayTrace);
      for (const [trace, acceptance] of [
        [firstTrace, "applied"],
        [replayTrace, "replayed"],
      ]) {
        assert(trace);
        const line = await worker.logLine(trace);
        assert.equal(line["requestId"], requestId);
        assert.equal(line["patternId"], pattern.id);
        assert.equal(line["jobId"], accepted.job.jobId);
        assert.equal(line["messageId"], accepted.job.messageId);
        assert.equal(line["messageNumber"], 1);
        assert.equal(line["acceptance"], acceptance);
        assert.equal(line["jobState"], undefined);
      }
      await error(await send({ ...body, body: `${body.body} changed` }), 422, "request_id_reused");
      await error(
        await send(body, `/api/patterns/${(await create()).id}/messages`),
        422,
        "request_id_reused",
      );
      await error(
        await worker.call("/api/projects", {
          method: "POST",
          as: owner,
          body: { requestId },
        }),
        422,
        "request_id_reused",
      );
      await settleJobs(worker, owner, pattern.id, [accepted.job.jobId]);
      assert.deepEqual((await state()).queuedJobs, []);
    },
  );

  const secondResponse = await send({ requestId: crypto.randomUUID(), body: "次の指示" });
  assert.equal(secondResponse.status, 202);
  const second = acceptInstructionResponseSchema.parse(await secondResponse.json());
  await t.test(
    "two instructions have consecutive receipts and finish without a revision",
    async () => {
      assert.equal(second.job.number, 2);
      assert.notEqual(second.job.jobId, accepted.job.jobId);
      assert.notEqual(second.job.messageId, accepted.job.messageId);
      await settleJobs(worker, owner, pattern.id, [accepted.job.jobId, second.job.jobId]);
      assert.deepEqual(await state(), {
        pattern,
        currentRevision: null,
        runningJob: null,
        queuedJobs: [],
        lastFinishedJob: { ...second.job, state: "failed" },
      });
      const history = await worker.call(`/api/patterns/${pattern.id}/revisions`, { as: owner });
      assert.equal(history.status, 200);
      assert.deepEqual(revisionListResponseSchema.parse(await history.json()), {
        revisions: [],
        nextCursor: null,
      });
    },
  );

  await t.test("a receipt remains identical after completion or cancellation", async () => {
    for (const jobState of ["completed", "cancelled"]) {
      await settleJobs(worker, owner, pattern.id, [accepted.job.jobId, second.job.jobId]);
      await worker.withPausedWorker(async (persisted) => {
        await execFileAsync(
          process.execPath,
          [
            fileURLToPath(new URL("./rpc/jobs-http-fixture.ts", import.meta.url)),
            persisted,
            accepted.job.jobId,
            jobState,
          ],
          { timeout: 120_000, maxBuffer: 1024 * 1024 },
        );
      });
      const replay = await send();
      assert.equal(replay.status, 202);
      assert.equal(await replay.text(), firstText);
      assert.deepEqual((await state()).queuedJobs, []);
    }
  });

  await t.test("invalid requests are not recorded and state rejects query parameters", async () => {
    const retryId = crypto.randomUUID();
    for (const invalid of [
      {},
      { requestId: "not-a-uuid", body: "指示" },
      ...[null, 42, "", " \t\n　", "x\ud800y", "x\udc00y"].map((body) => ({
        requestId: retryId,
        body,
      })),
      { requestId: retryId, body: "指示", extra: true },
    ]) {
      await error(
        await worker.call(path, { method: "POST", as: owner, body: invalid }),
        400,
        "invalid_request",
      );
    }
    await error(await raw(path, "{"), 400, "invalid_request");
    await error(
      await raw(path, JSON.stringify(body), { "content-type": "text/plain" }),
      400,
      "invalid_request",
    );
    await error(await raw(path, new Uint8Array([0xff])), 400, "invalid_request");
    const corrected = await send({ requestId: retryId, body: "修正した指示" });
    assert.equal(corrected.status, 202);
    const correctedJob = acceptInstructionResponseSchema.parse(await corrected.json()).job;
    assert.equal(correctedJob.number, 3);
    await settleJobs(worker, owner, pattern.id, [correctedJob.jobId]);
    for (const query of ["limit=1", "cursor=a&cursor=b", "__proto__=x"]) {
      await error(
        await worker.call(`${statePath}?${query}`, { as: owner }),
        400,
        "invalid_request",
      );
    }
  });

  await t.test("UTF-8 limits hold for ASCII, kana, emoji and escaped JSON", async () => {
    const boundaryPattern = await create();
    const boundaryPath = `/api/patterns/${boundaryPattern.id}/messages`;
    const jobIds: string[] = [];
    const remember = async (response: Response) => {
      assert.equal(response.status, 202);
      const job = acceptInstructionResponseSchema.parse(await response.json()).job;
      jobIds.push(job.jobId);
      assert.equal(job.number, jobIds.length);
    };
    const maximums = ["a".repeat(16384), "あ".repeat(5461) + "a", "😀".repeat(4096)];
    for (const text of maximums) {
      assert.equal(Buffer.byteLength(text), 16384);
      const valid = await send({ requestId: crypto.randomUUID(), body: text }, boundaryPath);
      await remember(valid);
      await error(
        await send({ requestId: crypto.randomUUID(), body: `${text}a` }, boundaryPath),
        400,
        "invalid_request",
      );
    }
    const escaped = (text: string) =>
      text
        .split("")
        .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
    for (const text of maximums) {
      for (const extra of ["", "a"]) {
        const json = `{"requestId":"${crypto.randomUUID()}","body":"${escaped(text + extra)}"}`;
        const response = await raw(boundaryPath, json);
        if (extra === "") await remember(response);
        else await error(response, 400, "invalid_request");
      }
    }
    for (const character of ["\n", '"']) {
      const response = await send(
        { requestId: crypto.randomUUID(), body: `x${character.repeat(16383)}` },
        boundaryPath,
      );
      await remember(response);
    }
    const json = JSON.stringify({ requestId: crypto.randomUUID(), body: "x" });
    const atLimit = json.padEnd(128 * 1024, " ");
    await remember(await raw(boundaryPath, atLimit));
    await error(await raw(boundaryPath, `${atLimit} `), 413, "payload_too_large");
    const streamed: RequestInit = {
      method: "POST",
      headers: {
        origin: testAppOrigin,
        "content-type": "application/json",
        [accessAssertionHeader]: token,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(atLimit));
          controller.enqueue(new TextEncoder().encode(" "));
          controller.close();
        },
      }),
      duplex: "half",
    };
    await error(await fetch(`${worker.origin}${boundaryPath}`, streamed), 413, "payload_too_large");
    await error(
      await raw(
        "/api/projects",
        JSON.stringify({ requestId: crypto.randomUUID(), name: "a" }).padEnd(16385, " "),
      ),
      413,
      "payload_too_large",
    );
    const response = await worker.call(`/api/patterns/${boundaryPattern.id}/state`, { as: owner });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(jobIds.length, 9);
    const settled = await settleJobs(worker, owner, boundaryPattern.id, jobIds);
    assert.equal(settled.runningJob, null);
    assert.deepEqual(settled.queuedJobs, []);
  });

  await t.test("no structured log contains the instruction marker", async () => {
    const response = await send();
    const trace = response.headers.get("x-trace-id");
    assert(trace);
    await worker.logLine(trace);
    await settleJobs(worker, owner, pattern.id, [accepted.job.jobId]);
    assert(!JSON.stringify(worker.logEntries()).includes(marker));
  });
});
