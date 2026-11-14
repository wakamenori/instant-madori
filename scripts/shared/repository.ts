import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";

export const repositoryRoot = new URL("../../", import.meta.url);

const upstreamPin = z.object({
  repository: z.url(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  initialCommit: z.string().regex(/^[a-f0-9]{40}$/),
  localPatches: z.array(
    z.string().refine((path) => !path.startsWith("/") && !path.split("/").includes("..")),
  ),
});

export function readUpstreamPin() {
  return upstreamPin.parse(
    JSON.parse(readFileSync(new URL("third_party/solidcraft.json", repositoryRoot), "utf8")),
  );
}

/** Cargo workspace membership drives format and unused-dependency checks. */
export function serviceCrates() {
  const metadata = z
    .object({
      packages: z.array(z.object({ id: z.string(), name: z.string(), manifest_path: z.string() })),
      workspace_members: z.array(z.string()),
    })
    .parse(
      JSON.parse(
        execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
          encoding: "utf8",
        }),
      ),
    );
  return metadata.packages
    .filter((pkg) => metadata.workspace_members.includes(pkg.id))
    .map((pkg) => ({ name: pkg.name, dir: dirname(pkg.manifest_path) }));
}
