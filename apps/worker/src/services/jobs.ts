/// <reference lib="es2024.string" />

import type { OwnerId } from "../owner.ts";
import type { Acceptance } from "../storage/jobs.ts";
import type { ServiceDeps, StoreDeps } from "./deps.ts";
import { requestKey } from "./requests.ts";

export type AcceptInstructionOutcome =
  | ({ kind: "accepted" } & Acceptance)
  | { kind: "invalid_message" }
  | { kind: "not_found" }
  | { kind: "request_id_reused" };

export async function acceptInstruction(
  { store, runtime }: StoreDeps<"jobs", "acceptOnce"> & Pick<ServiceDeps, "runtime">,
  input: { ownerId: OwnerId; requestId: string; patternId: string; body: string },
): Promise<AcceptInstructionOutcome> {
  const { ownerId, requestId, patternId, body } = input;
  if (!body.isWellFormed() || body.trim() === "" || new TextEncoder().encode(body).length > 16384) {
    return { kind: "invalid_message" };
  }
  const key = await requestKey(ownerId, requestId, "instruction.accept", { patternId, body });
  const once = await store.jobs.acceptOnce(key, {
    id: runtime.newId(),
    messageId: runtime.newId(),
    patternId,
    body,
    now: runtime.now(),
  });
  switch (once.kind) {
    case "applied":
    case "replayed":
      return { kind: "accepted", ...once.result };
    case "not_applied":
      return { kind: "not_found" };
    case "request_id_reused":
      return once;
  }
}
