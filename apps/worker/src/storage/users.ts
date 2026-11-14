import type { VerifiedIdentity } from "../identity.ts";
import { jsonRows } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { userSchema } from "@madori/contracts";
import type { User } from "@madori/contracts";

const userJson = "json_object('id', id, 'email', email)";

interface AccessUserInput {
  identity: VerifiedIdentity;
  newId: string;
  now: string;
}

class ResolvedAccessUser {
  readonly #issuer: string;
  readonly #subject: string;
  readonly #user: User;

  private constructor(identity: VerifiedIdentity, user: User) {
    this.#issuer = identity.issuer;
    this.#subject = identity.subject;
    this.#user = { ...user };
  }

  static userFor(this: void, identity: VerifiedIdentity, resolved: ResolvedAccessUser): User {
    if (resolved.#issuer !== identity.issuer || resolved.#subject !== identity.subject) {
      throw new Error("Access identity does not match the resolved user");
    }
    return { ...resolved.#user };
  }

  static async upsert(
    this: void,
    db: D1,
    { identity, newId, now }: AccessUserInput,
  ): Promise<ResolvedAccessUser> {
    const existing = await db.first(
      jsonRows(
        {
          sql: `SELECT ${userJson} AS json FROM users WHERE access_issuer = ? AND access_subject = ?`,
          bindings: [identity.issuer, identity.subject],
        },
        userSchema,
        "user",
      ),
    );
    if (existing?.email === identity.email) return new ResolvedAccessUser(identity, existing);
    const written = await db.first(
      jsonRows(
        {
          sql: `INSERT INTO users (id, access_issuer, access_subject, email, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (access_issuer, access_subject) DO UPDATE SET email = excluded.email
       RETURNING ${userJson} AS json`,
          bindings: [newId, identity.issuer, identity.subject, identity.email, now],
        },
        userSchema,
        "user",
      ),
    );
    if (written === null) throw new Error("User upsert returned no row");
    return new ResolvedAccessUser(identity, written);
  }
}

export type { ResolvedAccessUser };
export const upsertAccessUser = ResolvedAccessUser.upsert;
export const accessUserFor = ResolvedAccessUser.userFor;
