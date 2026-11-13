import { z } from "zod";
import type { ProjectPosition } from "../services/projects.ts";
import { ApiFailure } from "./http.ts";

// Cursors are opaque to clients: base64url of `[createdAt, id]` of the last item shown.
// SQL compares both as plain strings, so only the exact stored forms are accepted:
// `toISOString()` output and lowercase UUIDs. Anything else would misplace the page boundary.
const positionSchema = z.tuple([
  z.iso
    .datetime()
    .refine((value) => new Date(value).toISOString() === value, "must be a stored timestamp"),
  z.uuid().refine((value) => value === value.toLowerCase(), "must be lowercase"),
]);

export function encodeCursor(position: ProjectPosition): string {
  const bytes = new TextEncoder().encode(JSON.stringify([position.createdAt, position.id]));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor(cursor: string): ProjectPosition {
  let decoded: unknown;
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw new ApiFailure("invalid_request");
  }
  const position = positionSchema.safeParse(decoded);
  if (!position.success) throw new ApiFailure("invalid_request");
  const [createdAt, id] = position.data;
  return { createdAt, id };
}
