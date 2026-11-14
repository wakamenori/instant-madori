import { jsonRows } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { userSchema } from "@madori/contracts";
import type { User } from "@madori/contracts";

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
export async function upsertAccessUser(db: D1, input: AccessUserInput): Promise<User> {
  const existing = await db.first(
    jsonRows(
      {
        sql: `SELECT ${userJson} AS json FROM users WHERE access_issuer = ? AND access_subject = ?`,
        bindings: [input.issuer, input.subject],
      },
      userSchema,
      "user",
    ),
  );
  if (existing?.email === input.email) return existing;
  const written = await db.first(
    jsonRows(
      {
        sql: `INSERT INTO users (id, access_issuer, access_subject, email, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (access_issuer, access_subject) DO UPDATE SET email = excluded.email
       RETURNING ${userJson} AS json`,
        bindings: [input.newId, input.issuer, input.subject, input.email, input.now],
      },
      userSchema,
      "user",
    ),
  );
  if (written === null) throw new Error("User upsert returned no row");
  return written;
}
