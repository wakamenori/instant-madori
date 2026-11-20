import { hookPrivacy, telemetry } from "./privacy.ts";
import type { Candidate, Rejection } from "./envelope.ts";
const event = { kind: "event", sanitize: telemetry } as const;
export const registry = {
  "claude.otel.log": event,
  "claude.otel.metric": event,
  "codex.otel.log": event,
  "codex.otel.metric": event,
  "claude.hook": { ...event, sanitize: hookPrivacy },
  otlp: event,
  "t3.codex_link": event,
  "metrics.receiver": event,
};
export type RecordInput = Candidate<typeof registry>;
export type Parsed = {
  records: RecordInput[];
  rejects: Rejection[];
  drops: {
    source: keyof typeof registry;
    reason: "unknown_service" | "unattributed" | "foreign";
  }[];
};
