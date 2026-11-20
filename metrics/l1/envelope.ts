import { createHash } from "node:crypto";
import type { z } from "zod";

export type Json = z.core.util.JSONType;
export type Obj = { [key: string]: Json };
export type Registry = Record<
  string,
  { kind: "event" | "observation"; sanitize(payload: Obj): Obj }
>;
export type Scope =
  { kind: "repo" } | { kind: "proof"; subject: string } | { kind: "gated"; subject: string };
export type Candidate<R extends Registry> = {
  [S in keyof R]: {
    source: S & string;
    sourceVersion: string;
    occurredAt: string | null;
    naturalKey: string;
    payload: Obj;
    scope: R[S]["kind"] extends "observation" ? Exclude<Scope, { kind: "gated" }> : Scope;
  };
}[keyof R];
export type Rejection = { source: string; reason: string; unitHash: string; content: Obj | null };
export function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
