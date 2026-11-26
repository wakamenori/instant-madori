import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const mbxStoreSettings = {
  MBX_GC_AUTO: "1",
  MBX_GC_MIN_FREE_SIZE: "none",
  MBX_GC_MAX_TOTAL_SIZE: "8GiB",
} as const;

export function rustBuildTool() {
  const plain = { command: "cargo", env: process.env, fingerprint: "cargo" };
  if (process.env.GITHUB_ACTIONS !== undefined || process.env.MADORI_MBX === "0") return plain;
  const probe = spawnSync("mbx", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return plain;

  const env = {
    ...process.env,
    MBX_SHARE_WORKSPACE_ROOT: "1",
    MBX_TARGET_VIEWS: "0",
    MBX_LEARNED_INCREMENTAL: "0",
    MBX_CACHE_DIR: join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "instant-madori/mbx",
    ),
    ...mbxStoreSettings,
  };
  const fingerprint = JSON.stringify([
    probe.stdout.trim(),
    env.MBX_SHARE_WORKSPACE_ROOT,
    env.MBX_TARGET_VIEWS,
    env.MBX_LEARNED_INCREMENTAL,
  ]);
  return { command: "mbx", env, fingerprint };
}
