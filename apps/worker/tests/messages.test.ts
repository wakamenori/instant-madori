import assert from "node:assert/strict";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  acceptInstructionResponseSchema,
  createProjectResponseSchema,
  meResponseSchema,
  messageListResponseSchema,
  revisionListResponseSchema,
} from "@madori/contracts";
import { newUser, startLocalWorker } from "./support/local-worker.ts";

await test("Conversation pages retain their boundary when another instruction arrives", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());
  const owner = newUser("conversation-owner");
  const ownerId = meResponseSchema.parse(await (await worker.call("/api/me", { as: owner })).json())
    .user.id;
  const project = await worker.call("/api/projects", {
    method: "POST",
    as: owner,
    body: { requestId: crypto.randomUUID() },
  });
  const { pattern } = createProjectResponseSchema.parse(await project.json());
  const path = `/api/patterns/${pattern.id}/messages`;
  async function read(cursor?: string) {
    const response = await worker.call(path + (cursor ? `?cursor=${cursor}` : ""), { as: owner });
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    const page = messageListResponseSchema.parse(body);
    assert.deepEqual(page, body);
    return page;
  }
  assert.equal((await worker.call(path)).status, 401);
  for (const res of [
    await worker.call(path, { as: newUser("conversation-other") }),
    await worker.call(`/api/patterns/${crypto.randomUUID()}/messages`, { as: owner }),
  ]) {
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  }
  assert.deepEqual(await read(), { messages: [], nextCursor: null });
  for (const query of [
    "cursor=garbage",
    "cursor=MA",
    "cursor=LTE",
    "cursor=MS41",
    "cursor=bnVsbA",
    "cursor=MQ&cursor=Mg",
    "limit=2",
  ]) {
    const res = await worker.call(`${path}?${query}`, { as: owner });
    assert.equal(res.status, 400, query);
    assert.deepEqual(await res.json(), { error: "invalid_request" });
  }
  const fixture = await worker.withPausedWorker(async (state) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./rpc/conversation-fixture.ts", import.meta.url)),
      state,
      JSON.stringify({ ownerId, patternId: pattern.id }),
    ]);
    return z
      .object({
        ids: z.array(z.uuid()).length(55),
        now: z.iso.datetime(),
        jobId: z.uuid(),
        answerJobId: z.uuid(),
      })
      .parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
  });
  const history = revisionListResponseSchema.parse(
    await (await worker.call(`/api/patterns/${pattern.id}/revisions`, { as: owner })).json(),
  );
  const [revision] = history.revisions;
  assert(revision);
  const first = await read();
  assert.equal(first.messages.length, 50);
  assert.equal(first.nextCursor, Buffer.from("6").toString("base64url"));
  assert(first.nextCursor);
  const second = await read(first.nextCursor);
  assert.equal(second.nextCursor, null);
  const expected = fixture.ids.map((id, index) => {
    const kind =
      ["instruction", "explanation", "question", "answer", "notice", "instruction"][index] ??
      "notice";
    const linked = [0, 1, 2, 4].includes(index);
    return {
      id,
      number: index + 1,
      kind,
      body: kind,
      createdAt: fixture.now,
      jobId: linked ? fixture.jobId : kind === "answer" ? fixture.answerJobId : null,
      attachmentIds: [],
      revision: linked ? revision : null,
      ...(kind === "question" ? { choices: ["東", "南"] } : {}),
    };
  });
  assert.deepEqual([...first.messages, ...second.messages], expected.reverse());
  const posted = await worker.call(path, {
    as: owner,
    method: "POST",
    body: { requestId: crypto.randomUUID(), body: "another instruction" },
  });
  assert.equal(posted.status, 202);
  const { job } = acceptInstructionResponseSchema.parse(await posted.json());
  assert.equal(job.number, 56);
  assert.deepEqual(await read(first.nextCursor), second);
  assert.equal((await read()).messages[0]?.id, job.messageId);
});
