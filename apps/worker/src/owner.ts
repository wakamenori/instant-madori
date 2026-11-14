import type { User } from "@madori/contracts";
import { z } from "zod";

declare const ownerId: unique symbol;
/**
 * A user ID obtained from authentication. The symbol is not exported, so code outside this
 * file cannot spell the brand; lint rejects a direct `as OwnerId`, and the README lists the
 * indirect forms it cannot catch.
 */
export type OwnerId = string & { readonly [ownerId]: true };
export type AuthenticatedUser = Omit<User, "id"> & { id: OwnerId };

export function authenticatedUser(user: User): AuthenticatedUser {
  return { ...user, id: z.uuid().parse(user.id) as OwnerId };
}
