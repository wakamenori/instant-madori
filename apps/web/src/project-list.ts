import type { Project } from "@madori/contracts";
import type { ProjectListResponse as ProjectPage } from "@madori/contracts";

type More =
  | { kind: "end" }
  | { kind: "available"; cursor: string }
  | { kind: "loading"; cursor: string }
  | { kind: "failed"; cursor: string; message: string };

type ProjectList =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; projects: readonly Project[]; more: More };

type ProjectListEvent =
  | { kind: "retry_first" }
  | { kind: "first_page"; page: ProjectPage }
  | { kind: "first_page_failed"; message: string }
  | { kind: "more_requested" }
  | { kind: "next_page"; cursor: string; page: ProjectPage }
  | { kind: "next_page_failed"; cursor: string; message: string };

export const initialProjectList: ProjectList = { kind: "loading" };

export function reduceProjectList(list: ProjectList, event: ProjectListEvent): ProjectList {
  switch (event.kind) {
    case "retry_first":
      return list.kind === "failed" ? { kind: "loading" } : list;
    case "first_page":
      return { kind: "loaded", projects: event.page.projects, more: moreAfter(event.page) };
    case "first_page_failed":
      return { kind: "failed", message: event.message };
    case "more_requested":
      if (list.kind !== "loaded" || (list.more.kind !== "available" && list.more.kind !== "failed"))
        return list;
      return { ...list, more: { kind: "loading", cursor: list.more.cursor } };
    case "next_page":
    case "next_page_failed":
      if (
        list.kind !== "loaded" ||
        list.more.kind !== "loading" ||
        list.more.cursor !== event.cursor
      )
        return list;
      if (event.kind === "next_page_failed")
        return { ...list, more: { kind: "failed", cursor: event.cursor, message: event.message } };
      return {
        kind: "loaded",
        projects: [...list.projects, ...event.page.projects],
        more: moreAfter(event.page),
      };
  }
}

export function cursorToLoad(list: ProjectList): string | null {
  return list.kind === "loaded" && list.more.kind === "loading" ? list.more.cursor : null;
}

function moreAfter(page: ProjectPage): More {
  return page.nextCursor === null
    ? { kind: "end" }
    : { kind: "available", cursor: page.nextCursor };
}
export type CreateAttempt =
  | { kind: "idle" }
  | { kind: "sending"; requestId: string }
  | { kind: "failed"; requestId: string; message: string };
export function beginCreate(
  attempt: CreateAttempt,
): Extract<CreateAttempt, { kind: "sending" }> | null {
  if (attempt.kind === "sending") return null;
  return {
    kind: "sending",
    requestId: attempt.kind === "failed" ? attempt.requestId : crypto.randomUUID(),
  };
}

export function finishCreate(
  sending: Extract<CreateAttempt, { kind: "sending" }>,
  message: string | null,
): CreateAttempt {
  return message === null
    ? { kind: "idle" }
    : { kind: "failed", requestId: sending.requestId, message };
}
