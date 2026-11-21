import { z } from "zod";
import type { ProjectPosition } from "../services/projects.ts";
import { ApiFailure } from "./http.ts";

// Cursors are opaque to clients: base64url of the JSON position of the last item shown.
// SQL compares project positions as plain strings, so only the exact stored forms are
// accepted: `toISOString()` output and lowercase UUIDs. Anything else would misplace the
// page boundary.
const projectPositionSchema = z.tuple([
  z.iso
    .datetime()
    .refine((value) => new Date(value).toISOString() === value, "must be a stored timestamp"),
  z.uuid().refine((value) => value === value.toLowerCase(), "must be lowercase"),
]);

const numberPositionSchema = z.int().positive();

function encode(position: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode<T>(cursor: string, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw new ApiFailure("invalid_request");
  }
  const position = schema.safeParse(decoded);
  if (!position.success) throw new ApiFailure("invalid_request");
  return position.data;
}

export function encodeProjectCursor(position: ProjectPosition): string {
  return encode([position.createdAt, position.id]);
}

export function decodeProjectCursor(cursor: string): ProjectPosition {
  const [createdAt, id] = decode(cursor, projectPositionSchema);
  return { createdAt, id };
}

export function encodeRevisionCursor(number: number): string {
  return encode(number);
}

export function decodeRevisionCursor(cursor: string): number {
  return decode(cursor, numberPositionSchema);
}

export function encodeMessageCursor(number: number): string {
  return encode(number);
}

export function decodeMessageCursor(cursor: string): number {
  return decode(cursor, numberPositionSchema);
}
