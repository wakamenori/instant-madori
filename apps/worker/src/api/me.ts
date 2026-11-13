import type { MeResponse } from "@madori/contracts";
import type { Route } from "./router.ts";

export const meRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/me",
    handle: ({ user }) => Promise.resolve(Response.json({ user } satisfies MeResponse)),
  },
];
