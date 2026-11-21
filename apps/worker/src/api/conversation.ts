import { messageListQuerySchema } from "@madori/contracts";
import type { MessageListResponse } from "@madori/contracts";
import { listMessages } from "../services/messages.ts";
import { decodeMessageCursor, encodeMessageCursor } from "./cursor.ts";
import { ApiFailure, readQuery } from "./http.ts";
import { param } from "./router.ts";
import type { Route } from "./router.ts";

export const conversationRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/patterns/:patternId/messages",
    async handle(context) {
      const query = readQuery(context.url, messageListQuerySchema);
      const outcome = await listMessages(context.deps, {
        ownerId: context.user.id,
        patternId: param(context, "patternId"),
        before: query.cursor === undefined ? null : decodeMessageCursor(query.cursor),
      });
      switch (outcome.kind) {
        case "listed":
          return Response.json({
            messages: outcome.page.messages,
            nextCursor: outcome.page.next === null ? null : encodeMessageCursor(outcome.page.next),
          } satisfies MessageListResponse);
        case "not_found":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
];
