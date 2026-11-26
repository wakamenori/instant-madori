import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  apiErrorSchema,
  createProjectResponseSchema,
  meResponseSchema,
  pickResponseSchema,
} from "@madori/contracts";
import { newUser, startLocalWorker } from "./support/local-worker.ts";
import { revisionFixture } from "./revision-fixture.ts";

await test("Revision picks through local D1, R2 and public HTTP", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());
  const owner = newUser("pick-owner");
  const other = newUser("pick-other");
  const me = await worker.call("/api/me", { as: owner });
  const { user } = meResponseSchema.parse(await me.json());
  const project = await worker.call("/api/projects", {
    method: "POST",
    as: owner,
    body: { requestId: crypto.randomUUID() },
  });
  const { pattern } = createProjectResponseSchema.parse(await project.json());
  const { current, legacy } = z
    .object({ current: z.uuid(), legacy: z.uuid() })
    .parse(
      await revisionFixture(worker, { kind: "pick", ownerId: user.id, patternId: pattern.id }),
    );
  const call = (body: unknown, revision = current, as = owner, origin?: string | null) =>
    worker.call(`/api/revisions/${revision}/pick`, {
      method: "POST",
      body,
      as,
      ...(origin === undefined ? {} : { origin }),
    });
  const pick = async (element: string, hit?: { point: Vector; normal: Vector }) => {
    const res = await call({ element, hit });
    assert.equal(res.status, 200);
    const result = pickResponseSchema.parse(await res.json());
    assert.equal(result.target.revisionId, current);
    assert.equal(result.target.element, element);
    return result;
  };
  const vec = (x: number, y: number, z: number) => ({ x, y, z });
  type Vector = ReturnType<typeof vec>;
  const left = { kind: "room", room: "left" };
  const right = { kind: "room", room: "right" };
  const exterior = { kind: "exterior" };
  await t.test("wall dimensions and directed side roles", async () => {
    const mid = await pick("mid", { point: vec(3940, 2500, 1200), normal: vec(-1, 0, 0) });
    assert.deepEqual(mid.element, {
      kind: "wall",
      id: "mid",
      length: 5000,
      thickness: 120,
      height: 2400,
      faces: [
        { ...left, roomName: "left" },
        { ...right, roomName: "right" },
      ],
    });
    assert.deepEqual(mid.target.face, left);
    assert.deepEqual(
      (await pick("mid", { point: vec(4060, 2500, 1200), normal: vec(1, 0, 0) })).target.face,
      right,
    );
    const south = await pick("s-w", { point: vec(2000, -60, 1200), normal: vec(0, -1, 0) });
    assert.equal(south.element.kind, "wall");
    assert.deepEqual(south.element.faces, [{ ...left, roomName: "left" }, exterior]);
    assert.deepEqual(south.target.face, exterior);
  });
  await t.test("2D picks, caps and hits outside the side plane have no face", async () => {
    for (const hit of [
      undefined,
      { point: vec(4000, 2500, 2400), normal: vec(0, 0, 1) },
      { point: vec(3900, 2500, 1200), normal: vec(-1, 0, 0) },
    ]) {
      assert.equal((await pick("mid", hit)).target.face, null);
    }
  });
  await t.test("rooms and openings ignore face hits", async () => {
    const hit = { point: vec(3940, 2500, 1200), normal: vec(-1, 0, 0) };
    const room = await pick("left", hit);
    assert.deepEqual(room.element, { kind: "room", id: "left", name: "left", usage: "bedroom" });
    assert.equal(room.target.face, null);
    const door = await pick("door", hit);
    assert.deepEqual(door.element, {
      kind: "opening",
      id: "door",
      fitting: "door",
      wall: "mid",
      width: 900,
      height: 2100,
      sill: 0,
    });
    assert.equal(door.target.face, null);
  });
  await t.test(
    "rejects unavailable elements, legacy revisions, missing origin and invalid bodies",
    async () => {
      for (const [response, status, error] of [
        [await call({ element: "nope" }), 404, "not_found"],
        [await call({ element: "a" }), 404, "not_found"],
        [await call({ element: "mid" }, current, other), 404, "not_found"],
        [await call({ element: "mid" }, crypto.randomUUID()), 404, "not_found"],
        [await call({ element: "mid" }, legacy), 409, "not_selectable"],
        [await call({ element: "mid" }, current, owner, null), 403, "forbidden"],
        [await call({ element: "mid", extra: true }), 400, "invalid_request"],
        [
          await call({ element: "mid", hit: { point: vec(0, 0, 0), normal: vec(0, 0, 0) } }),
          400,
          "invalid_request",
        ],
      ] as const) {
        assert.equal(response.status, status);
        assert.deepEqual(apiErrorSchema.parse(await response.json()), { error });
      }
    },
  );
});
