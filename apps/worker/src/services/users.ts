import type { User } from "@madori/contracts";
import { upsertAccessUser } from "../storage/users.ts";
import type { ServiceDeps } from "./deps.ts";
import type { VerifiedIdentity } from "./identity.ts";

/**
 * Maps a verified identity to the internal user, creating it on first sign-in.
 * Who may sign in at all is decided by the Access policy (invitations), not here.
 */
export function resolveUser(
  { db, runtime }: ServiceDeps,
  identity: VerifiedIdentity,
): Promise<User> {
  return upsertAccessUser(db, { ...identity, newId: runtime.newId(), now: runtime.now() });
}
