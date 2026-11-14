import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";
import { repositoryRoot } from "../shared/repository.ts";
const workerConfig = z.object({
  name: z.string(),
  containers: z.array(z.object({ class_name: z.string() })),
});
const containerRow = z.object({ ID: z.string().regex(/^[a-f0-9]{12,64}$/), Names: z.string() });
function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function containerPatterns(config: z.infer<typeof workerConfig>): RegExp[] {
  return config.containers.map(
    ({ class_name }) =>
      new RegExp(
        `^workerd-${escaped(config.name)}-${escaped(class_name)}-[a-f0-9]{64}(?:-proxy)?$`,
      ),
  );
}
function containerRows(listing: string): z.infer<typeof containerRow>[] {
  return listing
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => containerRow.parse(JSON.parse(line)));
}
export function workerContainerIds(
  config: z.infer<typeof workerConfig>,
  listing: string,
): string[] {
  const patterns = containerPatterns(config);
  return containerRows(listing)
    .filter((row) => patterns.some((pattern) => pattern.test(row.Names)))
    .map((row) => row.ID);
}
function listContainers(): z.infer<typeof containerRow>[] {
  return containerRows(
    execFileSync("docker", ["ps", "-a", "--no-trunc", "--format", "{{json .}}"], {
      encoding: "utf8",
    }),
  );
}
export function snapshotWorkerContainers(): {
  ids: ReadonlySet<string>;
  patterns: readonly RegExp[];
} {
  const configPath = new URL("apps/worker/wrangler.jsonc", repositoryRoot);
  const parsed = ts.parseConfigFileTextToJson(
    fileURLToPath(configPath),
    readFileSync(configPath, "utf8"),
  );
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  const config = workerConfig.parse(parsed.config);
  return {
    ids: new Set(listContainers().map((row) => row.ID)),
    patterns: containerPatterns(config),
  };
}
/**
 * Removes newly observed containers matching the configuration captured at startup.
 * Concurrent local sessions of this worker (including other worktrees) are unsupported:
 * Miniflare shares their container names, so overlapping sessions and cleanup collide.
 * Crashed-session leftovers require manual removal as described in README.md.
 */
export function cleanupWorkerContainers(before: ReturnType<typeof snapshotWorkerContainers>): void {
  const ids = listContainers()
    .filter(
      (row) =>
        !before.ids.has(row.ID) && before.patterns.some((pattern) => pattern.test(row.Names)),
    )
    .map((row) => row.ID);
  // Wrangler 4.158 removes containers by the shape image, which excludes its egress proxy image.
  if (ids.length > 0) execFileSync("docker", ["rm", "--force", ...ids], { stdio: "inherit" });
}
