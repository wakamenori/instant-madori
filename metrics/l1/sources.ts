import { hookPrivacy, telemetry } from "./privacy.ts";
import type { Candidate, Rejection } from "./envelope.ts";
const event = { kind: "event", sanitize: telemetry } as const;
const observation = { ...event, kind: "observation" } as const;
export const registry = {
  "claude.otel.log": event,
  "claude.otel.metric": event,
  "codex.otel.log": event,
  "codex.otel.metric": event,
  "claude.hook": { ...event, sanitize: hookPrivacy },
  otlp: event,
  "github.issue": observation,
  "github.pr": observation,
  "github.comment": event,
  "github.actions.job": observation,
  "t3.thread": observation,
  "t3.run": observation,
  "t3.message": event,
  "t3.subagent": observation,
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
