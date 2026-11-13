import { userSchema } from "@madori/contracts";
import type { User } from "@madori/contracts";
import { parseJsonColumn } from "./rows.ts";

const userJson = "json_object('id', id, 'email', email)";

export interface AccessUserInput {
  issuer: string;
  subject: string;
  email: string;
  /** Used only if the user does not exist yet. */
  newId: string;
  now: string;
}

/**
 * Returns the user for an Access identity, creating it on first sign-in and following a
 * changed email. The common case (existing user, same email) is a single read.
 */
export async function upsertAccessUser(db: D1Database, input: AccessUserInput): Promise<User> {
  const existing = await db
    .prepare(`SELECT ${userJson} AS json FROM users WHERE access_issuer = ? AND access_subject = ?`)
    .bind(input.issuer, input.subject)
    .first("json");
  if (existing !== null) {
    const user = parseJsonColumn(existing, userSchema, "user");
    if (user.email === input.email) return user;
  }
  const written = await db
    .prepare(
      `INSERT INTO users (id, access_issuer, access_subject, email, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (access_issuer, access_subject) DO UPDATE SET email = excluded.email
       RETURNING ${userJson} AS json`,
    )
    .bind(input.newId, input.issuer, input.subject, input.email, input.now)
    .first("json");
  return parseJsonColumn(written, userSchema, "user");
}
