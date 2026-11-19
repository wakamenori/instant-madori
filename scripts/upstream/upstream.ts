import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import { readUpstreamPin } from "../shared/repository.ts";

const file = "third_party/solidcraft.json";
export async function writeUpstreamPin(
  pin: ReturnType<typeof readUpstreamPin>,
  destination = file,
) {
  const config = await resolveConfig(file);
  writeFileSync(destination, await format(JSON.stringify(pin), { ...config, filepath: file }));
}

if (import.meta.main) {
  const pin = readUpstreamPin();
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const command = process.argv[2];
  if (command === "check") {
    execFileSync("git", ["fetch", "--no-tags", pin.repository, "main"], { stdio: "inherit" });
    const latest = git(["rev-parse", "FETCH_HEAD"]);
    console.log(`Adopted: ${pin.commit}\nUpstream: ${latest}`);
    execFileSync("git", ["log", "--oneline", `${pin.commit}..${latest}`], { stdio: "inherit" });
    console.log(`Review the changes, then run: pnpm upstream:update ${latest}`);
  } else if (command === "update") {
    const requested = process.argv[3];
    if (!requested || !/^[0-9a-f]{40}$/.test(requested))
      throw new Error("Pass the full, reviewed upstream commit SHA.");
    if (git(["status", "--porcelain"]))
      throw new Error("Commit current work before an upstream update.");
    execFileSync("git", ["fetch", "--no-tags", pin.repository, "main"], { stdio: "inherit" });
    const target = git(["rev-parse", `${requested}^{commit}`]);
    // A service commit can also descend from the adopted pin; it is not an upstream update.
    execFileSync("git", ["merge-base", "--is-ancestor", target, "FETCH_HEAD"]);
    execFileSync("git", ["merge-base", "--is-ancestor", pin.commit, target]);
    if (target === pin.commit) {
      console.log("Already at the requested upstream commit.");
    } else {
      execFileSync("git", ["subtree", "merge", "--prefix=third_party/solidcraft", target], {
        stdio: "inherit",
      });
      await writeUpstreamPin({ ...pin, commit: target });
      console.log(
        "Upstream merged. Review patches and run pnpm check --full; record the result and commit the updated pin.",
      );
    }
  } else {
    throw new Error("Usage: node scripts/upstream/upstream.ts check | update <commit>");
  }
}
