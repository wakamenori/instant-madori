import type { OwnerId } from "../owner.ts";
import type { MessagePage } from "../storage/messages.ts";
import type { StoreDeps } from "./deps.ts";

const messagePageSize = 50;

export type ListMessagesOutcome = { kind: "listed"; page: MessagePage } | { kind: "not_found" };

export async function listMessages(
  { store }: StoreDeps<"messages", "list">,
  query: { ownerId: OwnerId; patternId: string; before: number | null },
): Promise<ListMessagesOutcome> {
  const page = await store.messages.list({ ...query, limit: messagePageSize });
  return page === null ? { kind: "not_found" } : { kind: "listed", page };
}
