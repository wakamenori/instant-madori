import { readFileSync } from "node:fs";
import { z } from "zod";

const upstreamPin = z.object({
  repository: z.url(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  initialCommit: z.string().regex(/^[a-f0-9]{40}$/),
  localPatches: z.array(
    z.string().refine((path) => !path.startsWith("/") && !path.split("/").includes("..")),
  ),
});

export function readUpstreamPin() {
  return upstreamPin.parse(JSON.parse(readFileSync("third_party/solidcraft.json", "utf8")));
}
