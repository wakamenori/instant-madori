import { scriptedAi } from "../../src/ai/scripted.ts";
import { fixtureHouse } from "./snapshot-support.ts";
import type { GeometryApi } from "../../src/geometry/geometry-client.ts";
export type OperationsResult = Awaited<ReturnType<GeometryApi["applyOperations"]>>;
export const editingAi = scriptedAi([
  {
    stop: "tool_calls",
    parts: [
      {
        kind: "tool_call",
        name: "edit_house",
        id: "edit",
        inputJson: JSON.stringify({ operations: [{ kind: "remove_opening", id: "door" }] }),
      },
    ],
  },
  {
    stop: "tool_calls",
    parts: [
      {
        kind: "tool_call",
        name: "finish",
        id: "finish",
        inputJson: JSON.stringify({
          answer: {
            kind: "plan",
            name: "台本の案",
            explanation: "説明",
            assumptions: ["平屋"],
            concerns: ["寸法"],
          },
        }),
      },
    ],
  },
]);
export const appliedFixture: OperationsResult = {
  kind: "ok",
  value: {
    kind: "applied",
    inspection: { housing: [], model: [] },
    operations: [],
    parts: [
      {
        artifact: { kind: "house" },
        bytes: fixtureHouse.data,
        byte_length: fixtureHouse.data.length,
      },
      { artifact: { kind: "display" }, bytes: new Uint8Array([1]), byte_length: 1 },
      {
        artifact: { kind: "floor_plan", storey: "s1" },
        bytes: new Uint8Array([2]),
        byte_length: 1,
      },
    ],
  },
  start: "warm",
  ms: 1,
};
