import { aiTools, aiToolSchemaVersion } from "@madori/contracts/ai-tools";
import type { ConversationMessage } from "@madori/contracts";
import { houseSummarySchema } from "@madori/contracts/geometry-internal";
import type { HouseSummary } from "@madori/contracts/geometry-internal";
import { z } from "zod";
type MessageKind = ConversationMessage["kind"];
export const prompt = {
  system:
    "Edit the working single-storey house to meet the user's instruction. The opening contains the current plan summary, earlier conversation if any, the current instruction, and inspection findings if available, in that order. Copy element IDs exactly. Use read_house for details when the summary is insufficient. Resolve blocking findings, then call finish alone with a named plan and explanation in Japanese. In assumptions list every provisional condition the plan relies on and anything you assumed that the user did not say. If you need an answer before continuing, call finish alone with a question and choices.",
  choices: "\nChoices: {choices}",
  order: ["summary", "conversation", "instruction", "checks"] as const,
  labels: {
    summary: "Current plan summary",
    conversation: "Earlier conversation",
    instruction: "Current instruction",
    checks: "Inspection findings",
  },
  speakers: {
    instruction: "User",
    answer: "User",
    question: "Assistant",
    explanation: "Assistant",
    notice: "Notice",
  } satisfies Record<MessageKind, string>,
  sectionSeparator: "\n",
  entry: "[#{number} {speaker}]\n",
  separator: "\n\n",
  omitted: "({n} older messages omitted.)",
  conversationBytes: 32768,
  summarySchema: z.toJSONSchema(houseSummarySchema),
};
function header(number: number, speaker: string) {
  return prompt.entry.replace("{number}", String(number)).replace("{speaker}", speaker);
}
export const conversationWindow = {
  budgetBytes: prompt.conversationBytes,
  entryOverheadBytes: Math.max(
    ...Object.values(prompt.speakers).map(
      (s) =>
        new TextEncoder().encode(
          header(Number.MAX_SAFE_INTEGER, s) +
            prompt.separator +
            prompt.choices.replace("{choices}", ""),
        ).length,
    ),
  ),
};
interface OpeningInput {
  summary: HouseSummary;
  messages: (Pick<ConversationMessage, "number" | "kind" | "body"> & {
    choices?: string[] | null;
  })[];
  total: number;
  instruction: string;
  checks: string | null;
}
function opening(input: OpeningInput) {
  const omitted = input.total - input.messages.length;
  const entries = input.messages.map(
    (m) =>
      header(m.number, prompt.speakers[m.kind]) +
      m.body +
      (m.choices ? prompt.choices.replace("{choices}", () => JSON.stringify(m.choices)) : ""),
  );
  if (omitted > 0) entries.unshift(prompt.omitted.replace("{n}", String(omitted)));
  const bodies = {
    summary: JSON.stringify(input.summary),
    conversation: entries.length ? entries.join(prompt.separator) : null,
    instruction: input.instruction,
    checks: input.checks,
  };
  return prompt.order.flatMap((k) =>
    bodies[k] === null
      ? []
      : [{ kind: "text" as const, text: prompt.labels[k] + prompt.sectionSeparator + bodies[k] }],
  );
}
export async function versionOf(definition: typeof prompt) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(definition)),
  );
  return (
    "sha256:" + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}
export async function prefix(model: string, input: OpeningInput) {
  return {
    format: 1,
    model,
    promptVersion: await versionOf(prompt),
    toolSchemaVersion: aiToolSchemaVersion,
    system: prompt.system,
    tools: aiTools,
    opening: opening(input),
  };
}
export const prefixSchema = z.strictObject({
  format: z.literal(1),
  model: z.string(),
  promptVersion: z.string(),
  toolSchemaVersion: z.string(),
  system: z.string(),
  tools: z.array(
    z.strictObject({ name: z.string(), description: z.string(), inputSchemaJson: z.string() }),
  ),
  opening: z.array(z.strictObject({ kind: z.literal("text"), text: z.string() })).min(1),
});
