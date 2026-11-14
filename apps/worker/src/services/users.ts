import { authenticatedUser } from "../owner.ts";
import type { AuthenticatedUser } from "../owner.ts";
import type { ServiceDeps, StoreDeps } from "./deps.ts";
import type { VerifiedIdentity } from "./identity.ts";

/**
 * Maps a verified identity to the internal user, creating it on first sign-in.
 * Who may sign in at all is decided by the Access policy (invitations), not here.
 */
export async function resolveUser(
  { store, runtime }: StoreDeps<"users", "upsertAccess"> & Pick<ServiceDeps, "runtime">,
  identity: VerifiedIdentity,
): Promise<AuthenticatedUser> {
  return authenticatedUser(
    identity,
    await store.users.upsertAccess({ identity, newId: runtime.newId(), now: runtime.now() }),
  );
}
