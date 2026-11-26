import { z } from "zod";
import type { Conversation } from "./round-trip.ts";
import type { ScriptStep } from "./scripted.ts";

function firstItem<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Missing expected item in tool result");
  return item;
}
const roomSchema = z.object({
  id: z.string(),
  edges: z.array(z.object({ boundary: z.string() })).nonempty(),
});
const layout = {
  rooms: [{ name: "LDK", usage: "ldk", min: { x: 0, y: 0 }, max: { x: 4000, y: 3000 } }],
  walls: { exterior_thickness: 200, interior_thickness: 100, height: 2800 },
};
const paint = (wall: string, room: string) => ({
  kind: "set_wall_color",
  wall_color: { wall, face: { kind: "room", room }, color: { r: 217, g: 199, b: 167 } },
});
const opening = (wall: string, door: boolean, distance: number) => ({
  kind: "attach_opening",
  opening: {
    wall,
    from: "start",
    distance,
    width: door ? 900 : 1200,
    height: door ? 2000 : 1000,
    sill: door ? 0 : 900,
    fitting: door ? { kind: "door", hinge: "start", opens_to: "right" } : { kind: "window" },
  },
});

export function developmentScript({ opening: parts, rounds }: Conversation): ScriptStep {
  function section(label: string) {
    const part = parts.find((p) => p.kind === "text" && p.text.startsWith(label + "\n"));
    if (part?.kind !== "text") throw new Error("Missing " + label);
    return part.text.slice(label.length + 1);
  }
  const first = section("Current instruction").split(/\r?\n/u, 1)[0];
  const name = first?.startsWith("台本:") ? first.slice(3) : "plan";
  if (!["plan", "unresolved", "reject-window"].includes(name)) throw new Error("unknown script");
  const house = z
    .object({
      rooms: z.array(z.object({ id: z.string(), walls: z.array(z.string()).nonempty() })),
      openings: z.array(z.object({ id: z.string(), kind: z.string() })),
    })
    .parse(JSON.parse(section("Current plan summary")));
  const round = rounds.length + 1;
  const call = (tool: string, input: object): ScriptStep => ({
    stop: "tool_calls",
    parts: [
      { kind: "tool_call", id: `call-${round}`, name: tool, inputJson: JSON.stringify(input) },
    ],
  });
  const edit = (...operations: object[]) => call("edit_house", { operations });
  const inspect = (ids: string[]) => call("read_house", { query: { kind: "elements", ids } });
  const finish = () =>
    call("finish", {
      answer: {
        kind: "plan",
        name: name === "reject-window" ? "窓を直した案" : "台本の案",
        explanation: house.rooms.length
          ? "LDKの壁の色を変更しました。"
          : "LDKの外壁に玄関ドアと窓を設けました。",
        assumptions: ["平屋を想定しました。"],
        concerns: [],
      },
    });
  function result(r: number, isError = false): unknown {
    const reply = rounds[r - 1]?.reply;
    const found =
      reply?.kind === "tool_results" && reply.results.find((item) => item.callId === `call-${r}`);
    const content = found && found.content[0];
    if (!found || found.isError !== isError || !content || content.kind !== "text")
      throw new Error(`Unexpected result in round ${r}`);
    return JSON.parse(content.text);
  }
  if (house.rooms.length) {
    if (round > 1) {
      result(1);
      return finish();
    }
    if (name === "unresolved") {
      const door = house.openings.find((o) => o.kind === "door");
      if (!door) throw new Error("Expected a door");
      return edit({ kind: "remove_opening", id: door.id });
    }
    const room = firstItem(house.rooms);
    return edit(paint(firstItem(room.walls), room.id));
  }
  if (round === 1) return edit({ kind: "place_rooms", layout });
  const applied = z
    .object({
      operations: z
        .array(z.object({ rooms: z.array(z.object({ id: z.string() })).nonempty() }))
        .nonempty(),
    })
    .parse(result(1));
  if (name === "unresolved") return finish();
  const id = firstItem(firstItem(applied.operations).rooms).id;
  if (round === 2) return inspect([id]);
  const read = z
    .object({ elements: z.array(z.object({ value: roomSchema })).nonempty() })
    .parse(result(2));
  const room = firstItem(read.elements).value;
  const wall = firstItem(room.edges).boundary;
  const second = room.edges[1]?.boundary;
  if (!second) throw new Error("Expected a second boundary");
  const repair = () => edit(opening(wall, true, 500), opening(second, false, 800), paint(wall, id));
  if (name === "reject-window") {
    if (round === 3) return edit(opening(second, false, 20000));
    z.object({ kind: z.literal("rejected"), index: z.literal(0) }).parse(result(3, true));
    if (round === 4) return repair();
    result(4);
    if (round === 5) return inspect([second]);
    z.object({
      elements: z
        .array(
          z.object({
            openings: z
              .array(z.object({ fitting: z.object({ kind: z.literal("window") }) }))
              .length(1),
          }),
        )
        .nonempty(),
    }).parse(result(5));
  } else {
    if (round === 3) return repair();
    result(3);
  }
  return finish();
}
