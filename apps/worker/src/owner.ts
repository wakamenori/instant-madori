import type { User } from "@madori/contracts";
import { z } from "zod";
import type { VerifiedIdentity } from "./identity.ts";
import { accessUserFor } from "./storage/users.ts";
import type { ResolvedAccessUser } from "./storage/users.ts";

declare const ownerId: unique symbol;
export type OwnerId = string & { readonly [ownerId]: true };
export type AuthenticatedUser = Omit<User, "id"> & { id: OwnerId };

export function authenticatedUser(
  identity: VerifiedIdentity,
  resolved: ResolvedAccessUser,
): AuthenticatedUser {
  const user = accessUserFor(identity, resolved);
  return { ...user, id: z.uuid().parse(user.id) as OwnerId };
}
