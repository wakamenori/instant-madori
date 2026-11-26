import type { FaceRole, PickRequest, PickResponse, PickedElement } from "@madori/contracts";
import type { OwnerId } from "../owner.ts";
import type { StoredHouse } from "../storage/snapshots.ts";
import type { StoreDeps } from "./deps.ts";

const normalTolerance = 1e-4;
const sidePlaneToleranceMm = 1;
type Wall = Extract<PickedElement, { kind: "wall" }>;
type PickResult = ({ kind: "picked" } & PickResponse) | { kind: "not_found" };

export function selectElement(
  house: StoredHouse,
  revisionId: string,
  { element: id, hit }: PickRequest,
): PickResult {
  function picked(element: PickedElement, face: FaceRole | null = null): PickResult {
    return { kind: "picked", target: { revisionId, element: id, face }, element };
  }
  const boundary = house.boundaries.find((b) => b.id === id);
  if (boundary) {
    const start = house.vertices.find((v) => v.id === boundary.start)?.at;
    const end = house.vertices.find((v) => v.id === boundary.end)?.at;
    if (!start || !end) throw new Error("Wall references a missing vertex");
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const { offsets, height } = boundary.wall;
    const faces: Wall["faces"] = [{ kind: "exterior" }, { kind: "exterior" }];
    for (const room of house.rooms) {
      for (const edge of room.edges) {
        if (edge.boundary === id)
          faces[edge.direction === "forward" ? 0 : 1] = {
            kind: "room",
            room: room.id,
            roomName: room.name,
          };
      }
    }
    let face: FaceRole | null = null;
    if (hit) {
      const leftX = -dy / length;
      const leftY = dx / length;
      const { normal, point } = hit;
      const alignment =
        (normal.x * leftX + normal.y * leftY) / Math.hypot(normal.x, normal.y, normal.z);
      const distance = (point.x - start.x) * leftX + (point.y - start.y) * leftY;
      const hitsSidePlane = (sign: 1 | -1, offset: number) =>
        sign * alignment >= 1 - normalTolerance &&
        Math.abs(sign * distance - offset) <= sidePlaneToleranceMm;
      const side = hitsSidePlane(1, offsets.left)
        ? faces[0]
        : hitsSidePlane(-1, offsets.right)
          ? faces[1]
          : undefined;
      if (side) face = side.kind === "room" ? { kind: "room", room: side.room } : side;
    }
    return picked(
      { kind: "wall", id, length, thickness: offsets.left + offsets.right, height, faces },
      face,
    );
  }
  const room = house.rooms.find((r) => r.id === id);
  if (room) return picked({ kind: "room", id, name: room.name, usage: room.usage });
  const opening = house.openings.find((o) => o.id === id);
  if (!opening) return { kind: "not_found" };
  const { wall, width, height, sill, fitting } = opening;
  return picked({ kind: "opening", id, wall, width, height, sill, fitting: fitting.kind });
}

export async function pickElement(
  { store }: StoreDeps<"revisions", "snapshot"> & StoreDeps<"snapshots", "open">,
  { ownerId, revisionId, request }: { ownerId: OwnerId; revisionId: string; request: PickRequest },
): Promise<PickResult | { kind: "not_selectable" }> {
  const snapshot = await store.revisions.snapshot({ ownerId, revisionId });
  if (!snapshot) return { kind: "not_found" };
  if (snapshot.formatVersion === 1) return { kind: "not_selectable" };
  const { house } = await store.snapshots.open(snapshot);
  if (!house) throw new Error("Missing house in format-2 snapshot");
  return selectElement(await house.readHouse(), revisionId, request);
}
