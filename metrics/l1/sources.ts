import { codexHookPrivacy, hookPrivacy, logPrivacy, telemetry } from "./privacy.ts";
import type { Candidate, Rejection } from "./envelope.ts";
const event = { kind: "event", sanitize: telemetry } as const;
const observation = { ...event, kind: "observation" } as const;
export const registry = {
  "claude.otel.log": { ...event, sanitize: logPrivacy },
  "claude.otel.metric": event,
  "codex.otel.log": { ...event, sanitize: logPrivacy },
  "codex.otel.metric": event,
  "codex.hook": { ...event, sanitize: codexHookPrivacy },
  "claude.hook": { ...event, sanitize: hookPrivacy },
  "docker.slot": event,
  otlp: event,
  "github.commit": event,
  "github.commit_status": event,
  "classification.backfill": observation,
  "github.issue": observation,
  "github.issue.timeline": event,
  "github.actions.attempt": observation,
  "github.pr": observation,
  "github.comment": event,
  "github.actions.job": observation,
  "t3.thread": observation,
  "t3.run": observation,
  "t3.message": event,
  "t3.approval": observation,
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
