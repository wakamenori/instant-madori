import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  commentRecord,
  issueRecord,
  jobRecord,
  prRecord,
  reference,
  runSchema,
} from "../ingest/github.ts";
import type { Poller } from "./poller.ts";
import type { RecordInput } from "../l1/sources.ts";

const repo = "https://api.github.com/repos/wakamenori/instant-madori/";
const first = "2026-11-01T00:00:00.000Z";
const stateSchema = z.object({
  since: z.string(),
  tags: z.record(z.string(), z.object({ etag: z.string(), next: z.string().nullable() })),
});
export class BudgetLimit extends Error {}
export function githubPollers(home: string): Poller[] {
  return (["github.issue", "github.pr", "github.comment", "github.actions.job"] as const).map(
    (name) => {
      const path = join(home, name + ".cursor.json");
      let state: z.infer<typeof stateSchema> = { since: first, tags: {} };
      try {
        state = stateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        /* A missing or invalid checkpoint replays the source. */
      }
      let pending = state;
      return {
        name,
        intervalMs: name === "github.actions.job" ? 120_000 : 300_000,
        committed() {
          writeFileSync(path + ".tmp", JSON.stringify(pending), { mode: 0o600 });
          renameSync(path + ".tmp", path);
          state = pending;
        },
        async poll(signal) {
          const token = (
            await promisify(execFile)("gh", ["auth", "token"], { signal })
          ).stdout.trim();
          const headers = { Authorization: "Bearer " + token };
          const budget = await fetch("https://api.github.com/rate_limit", { headers, signal });
          if (!budget.ok) throw new Error("Rate limit unavailable");
          let remaining = z
            .object({ resources: z.object({ core: z.object({ remaining: z.number() }) }) })
            .parse(await budget.json()).resources.core.remaining;
          if (remaining < 1500) throw new BudgetLimit();
          const now = Date.now(),
            records: RecordInput[] = [];
          pending = { since: new Date(now - 60_000).toISOString(), tags: { ...state.tags } };
          async function page(url: string, conditional: boolean) {
            if (new URL(url).origin !== new URL(repo).origin)
              throw new Error("Unexpected pagination origin");
            if (remaining < 1500) throw new BudgetLimit();
            const saved = conditional ? state.tags[url] : undefined;
            const response = await fetch(url, {
              headers: saved ? { ...headers, "If-None-Match": saved.etag } : headers,
              signal,
              redirect: "error",
            });
            remaining = Number(response.headers.get("x-ratelimit-remaining") ?? 0);
            if (response.status === 304 && saved) return { data: null, next: saved.next };
            if (!response.ok) throw new Error("GitHub HTTP " + response.status);
            const next = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/u)?.[1] ?? null;
            const etag = response.headers.get("etag");
            if (conditional && etag) pending.tags[url] = { etag, next };
            return { data: await response.json(), next };
          }
          async function pages(endpoint: string, key?: string, conditional = true) {
            let url: string | null = repo + endpoint;
            const rows: unknown[] = [];
            while (url) {
              const p = await page(url, conditional);
              if (p.data !== null)
                rows.push(
                  ...z
                    .array(z.unknown())
                    .parse(key ? z.record(z.string(), z.unknown()).parse(p.data)[key] : p.data),
                );
              url = p.next;
            }
            return rows;
          }
          if (name === "github.actions.job") {
            for (const workflow of ["check", "deploy-staging"]) {
              // Partition the created filter to stay below the Actions search cap. Revisit older runs for reruns.
              for (let start = Date.parse(first); start <= now; start += 7 * 86400_000) {
                const day = (v: number) => new Date(v).toISOString().slice(0, 10);
                const range = day(start) + ".." + day(start + 6 * 86400_000);
                for (const raw of await pages(
                  "actions/workflows/" + workflow + ".yml/runs?per_page=100&created=" + range,
                  "workflow_runs",
                )) {
                  const run = runSchema.parse(raw);
                  if (
                    state.since !== first &&
                    Date.parse(run.updated_at) < Math.min(Date.parse(state.since), now - 3600_000)
                  )
                    continue;
                  for (const job of await pages(
                    "actions/runs/" + run.id + "/jobs?filter=all&per_page=100",
                    "jobs",
                  ))
                    records.push(jobRecord(job, run, workflow));
                }
              }
            }
          } else if (name === "github.comment") {
            for (const raw of await pages("issues/comments?per_page=100&since=" + state.since))
              records.push(commentRecord(raw));
          } else {
            for (const raw of await pages("issues?state=all&per_page=100&since=" + state.since)) {
              const issue = reference
                .extend({
                  pull_request: z.unknown().optional(),
                  sub_issues_summary: z.unknown().optional(),
                })
                .parse(raw);
              if (name === "github.pr" && issue.pull_request) {
                const p = await page(repo + "pulls/" + issue.number, true);
                if (p.data !== null) records.push(prRecord(p.data));
              } else if (name === "github.issue" && !issue.pull_request) {
                const blockers = await pages(
                  "issues/" + issue.number + "/dependencies/blocked_by?per_page=100",
                  undefined,
                  false,
                );
                records.push(issueRecord(raw, blockers));
              }
            }
          }
          // Only stable URLs benefit from validators on the next cycle.
          for (const key of Object.keys(pending.tags))
            if (key.includes("since=")) delete pending.tags[key];
          return records;
        },
      };
    },
  );
}
