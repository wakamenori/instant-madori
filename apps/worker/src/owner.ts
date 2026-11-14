import type { User } from "@madori/contracts";
import { z } from "zod";

declare const ownerId: unique symbol;
export type OwnerId = string & { readonly [ownerId]: true };
export type AuthenticatedUser = Omit<User, "id"> & { id: OwnerId };

export function authenticatedUser(user: User): AuthenticatedUser {
  return { ...user, id: z.uuid().parse(user.id) as OwnerId };
}
