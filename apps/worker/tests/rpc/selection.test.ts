import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { selectElement } from "../../src/services/selection.ts";
import { parseStoredHouse, type StoredHouse } from "../../src/storage/snapshots.ts";

await test("reads every stored housing fixture", async () => {
  const dir = new URL("../../../../crates/housing/tests/fixtures/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  assert(files.length);
  for (const file of files) parseStoredHouse(await readFile(new URL(file, dir), "utf8"));
});

function polygon(
  vertices: [string, number, number][],
  walls: [string, string, string, number, number][],
): StoredHouse {
  return {
    vertices: vertices.map(([id, x, y]) => ({ id, at: { x, y } })),
    boundaries: walls.map(([id, start, end, offset, height]) => ({
      id,
      start,
      end,
      wall: { offsets: { left: offset, right: offset }, height },
    })),
    rooms: [
      {
        id: "r",
        name: "R",
        usage: "bedroom",
        edges: walls.map(([boundary]) => ({ boundary, direction: "forward" })),
      },
    ],
    openings: [],
  };
}

await test("wall picks distinguish painted planes from CAD joint faces", () => {
  const rectangle = polygon(
    [
      ["a", 0, 0],
      ["b", 5000, 0],
      ["c", 5000, 4000],
      ["d", 0, 4000],
    ],
    [
      ["s", "a", "b", 30, 2700],
      ["e", "b", "c", 150, 2400],
      ["n", "c", "d", 150, 2400],
      ["w", "d", "a", 150, 2400],
    ],
  );
  const triangle = polygon(
    [
      ["a", 0, 0],
      ["b", 6000, 0],
      ["c", 6000, 2000],
    ],
    [
      ["ab", "a", "b", 100, 2400],
      ["bc", "b", "c", 100, 2400],
      ["ca", "c", "a", 100, 2400],
    ],
  );
  for (const [house, element, x, y, nx, ny, face] of [
    [rectangle, "s", 5050, -10, 0.196, 0.981, null],
    [rectangle, "s", 2500, 30, 0, 1, { kind: "room", room: "r" }],
    [rectangle, "s", 2500, -30, 0, -1, { kind: "exterior" }],
    [triangle, "ab", 205, 33, -0.16, 0.987, null],
  ] as const) {
    const result = selectElement(house, crypto.randomUUID(), {
      element,
      hit: { point: { x, y, z: 900 }, normal: { x: nx, y: ny, z: 0 } },
    });
    assert.equal(result.kind, "picked");
    assert.deepEqual(result.target.face, face);
  }
});
