import { execFileSync } from "node:child_process";
import { z } from "zod";

const licenses = z
  .record(z.string(), z.array(z.object({ name: z.string(), versions: z.array(z.string()) })))
  .parse(JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" })));
const rejected = Object.entries(licenses).filter(([license]) =>
  /(?:^|[^A-Za-z])(?:AGPL|GPL|LGPL)(?:-|\b)|UNLICENSED|UNKNOWN/i.test(license),
);
if (rejected.length) {
  for (const [license, packages] of rejected) {
    console.error(
      `${license}: ${packages.map(({ name, versions }) => `${name}@${versions.join(",")}`).join("; ")}`,
    );
  }
  throw new Error("JavaScript dependency licenses violate the repository policy or need review.");
}
console.log(`JavaScript license policy passed: ${Object.values(licenses).flat().length} packages.`);
