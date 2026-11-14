import { execFileSync } from "node:child_process";
import { serviceCrates } from "../shared/repository.ts";
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check"))
  throw new Error("Usage: node scripts/check/rust-format.ts [--check]");
execFileSync(
  "cargo",
  [
    "fmt",
    ...serviceCrates().flatMap((crate) => ["-p", crate.name]),
    ...(args.length ? ["--", "--check"] : []),
  ],
  { stdio: "inherit" },
);
