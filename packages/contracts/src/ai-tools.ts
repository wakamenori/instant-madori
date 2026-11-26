/// <reference lib="es2024.string" />
import type { z } from "zod";
import { nameSchema } from "./index.ts";
import {
  editHouseInputSchema,
  readHouseInputSchema,
  finishInputSchema,
  type EditHouseInput,
  type ReadHouseInput,
  type FinishInput,
} from "./generated/ai-tools.ts";
export { aiTools, aiToolSchemaVersion } from "./generated/ai-tools.ts";
export type { EditHouseInput, ReadHouseInput, FinishInput } from "./generated/ai-tools.ts";

export type AiToolCall =
  | { readonly name: "edit_house"; readonly input: EditHouseInput }
  | { readonly name: "read_house"; readonly input: ReadHouseInput }
  | { readonly name: "finish"; readonly input: FinishInput };
/** `error` is text for the model, returned to it as an error tool result. */
export type ParsedToolCall =
  { readonly ok: true; readonly call: AiToolCall } | { readonly ok: false; readonly error: string };

function invalid(error: z.ZodError, prefix: PropertyKey[] = []): ParsedToolCall {
  return {
    ok: false,
    error: error.issues
      .map(
        (issue) => `${[...prefix, ...issue.path].map(String).join(".") || "$"}: ${issue.message}`,
      )
      .join("\n"),
  };
}

export function parseToolCall(name: string, inputJson: string): ParsedToolCall {
  let input: unknown;
  try {
    input = JSON.parse(inputJson, (key: string, value: unknown): unknown => {
      if (!key.isWellFormed() || (typeof value === "string" && !value.isWellFormed()))
        throw new Error("Tool input must be well-formed Unicode");
      return value;
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "Expected an object" };
  switch (name) {
    case "edit_house": {
      const result = editHouseInputSchema.safeParse(input);
      return result.success
        ? { ok: true, call: { name, input: result.data } }
        : invalid(result.error);
    }
    case "read_house": {
      const result = readHouseInputSchema.safeParse(input);
      return result.success
        ? { ok: true, call: { name, input: result.data } }
        : invalid(result.error);
    }
    case "finish": {
      const result = finishInputSchema.safeParse(input);
      if (!result.success) return invalid(result.error);
      if (result.data.answer.kind === "plan") {
        const planName = nameSchema.safeParse(result.data.answer.name);
        if (!planName.success) return invalid(planName.error, ["answer", "name"]);
      }
      return { ok: true, call: { name, input: result.data } };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
