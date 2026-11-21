import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  blockerSchema,
  changedFile,
  closureReference,
  runRecord,
  timelineEvent,
  timelineRecord,
  commentRecord,
  commentRulesVersion,
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
  tags: z.record(
    z.string(),
    z.object({
      etag: z.string(),
      next: z.string().nullable(),
      context: z.string().optional(),
      cached: z.array(z.union([blockerSchema, runSchema, changedFile, reference])).optional(),
    }),
  ),
});
export class BudgetLimit extends Error {}
async function authToken(signal: AbortSignal) {
  return (await promisify(execFile)("gh", ["auth", "token"], { signal })).stdout.trim();
}
export function githubPollers(home: string, tokenFor = authToken, request = fetch): Poller[] {
  const sources = [
    "github.issue",
    "github.pr",
    "github.issue.timeline",
    "github.comment",
    "github.actions.job",
  ] as const;
  return sources.map((name) => {
    const version =
      name === "github.comment" || name === "github.issue"
        ? "." + commentRulesVersion
        : name === "github.pr"
          ? ".3"
          : ".2";
    const path = join(home, name + version + ".cursor.json");
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
        const token = await tokenFor(signal);
        const headers = { Authorization: "Bearer " + token };
        const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        const budget = await request("https://api.github.com/rate_limit", {
          headers,
          signal: timeout(),
        });
        if (!budget.ok) throw new Error("Rate limit unavailable");
        const limit = z.object({ remaining: z.number() });
        const { core, graphql } = z
          .object({ resources: z.object({ core: limit, graphql: limit.optional() }) })
          .parse(await budget.json()).resources;
        let remaining = core.remaining,
          graphRemaining = graphql?.remaining ?? 0;
        if (remaining < 1500) throw new BudgetLimit();
        const now = Date.now(),
          records: RecordInput[] = [];
        pending = { since: new Date(now - 60_000).toISOString(), tags: { ...state.tags } };
        async function page(url: string, context = "") {
          if (new URL(url).origin !== new URL(repo).origin)
            throw new Error("Unexpected pagination origin");
          if (remaining < 1500) throw new BudgetLimit();
          const old = state.tags[url];
          const saved = old && (old.context ?? "") === context ? old : undefined;
          const response = await request(url, {
            headers: saved ? { ...headers, "If-None-Match": saved.etag } : headers,
            signal: timeout(),
            redirect: "error",
          });
          remaining = Number(response.headers.get("x-ratelimit-remaining") ?? 0);
          if (response.status === 304 && saved) return { data: null, next: saved.next };
          if (!response.ok) throw new Error("GitHub HTTP " + response.status);
          const next = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/u)?.[1] ?? null;
          const etag = response.headers.get("etag");
          if (etag) pending.tags[url] = { etag, next, context };
          else delete pending.tags[url];
          return { data: await response.json(), next };
        }
        async function lookupCloser(nodeId: string) {
          if (graphRemaining < 1500 || remaining < 1500) throw new BudgetLimit();
          const response = await request("https://api.github.com/graphql", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            signal: timeout(),
            redirect: "error",
            body: JSON.stringify({
              query: `query($id:ID!){node(id:$id){... on ClosedEvent{closer{__typename ... on Commit{oid} ... on PullRequest{number repository{nameWithOwner} mergeCommit{oid}}}}}}`,
              variables: { id: nodeId },
            }),
          });
          graphRemaining = Number(response.headers.get("x-ratelimit-remaining") ?? 0);
          if (!response.ok) throw new Error("GitHub HTTP " + response.status);
          return closureReference(await response.json());
        }
        async function pages(endpoint: string, key?: string, context = "") {
          let url: string | null = repo + endpoint;
          const rows: unknown[] = [];
          while (url) {
            const p = await page(url, context);
            const tag = pending.tags[url];
            if (p.data === null) rows.push(...(tag?.cached ?? []));
            else {
              const values = z
                .array(z.unknown())
                .parse(key ? z.record(z.string(), z.unknown()).parse(p.data)[key] : p.data);
              rows.push(...values);
              if (tag && key === "workflow_runs")
                tag.cached = values
                  .map((r) => runSchema.parse(r))
                  .filter((r) => !r.conclusion || Date.parse(r.updated_at) >= now - 3600_000);
              if (tag && endpoint.includes("/files?"))
                tag.cached = values.map((v) => changedFile.parse(v));
              if (tag && endpoint.startsWith("commits/"))
                tag.cached = values.map((v) => reference.parse(v));
              if (tag && endpoint.includes("/dependencies/blocked_by"))
                tag.cached = values.map((v) => blockerSchema.parse(v));
            }
            url = p.next;
          }
          return rows;
        }
        // Reuse validators within a UTC day. The timestamp cursor still limits detail requests.
        const sinceDay = state.since.slice(0, 10) + "T00:00:00Z";
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
                  run.conclusion &&
                  state.since !== first &&
                  Date.parse(run.updated_at) < Math.min(Date.parse(state.since), now - 3600_000)
                )
                  continue;
                for (let n = 1; n <= run.run_attempt; n++) {
                  const endpoint = "actions/runs/" + run.id + "/attempts/" + n;
                  let attempt = run;
                  if (n !== run.run_attempt) {
                    const detail = await page(repo + endpoint);
                    if (detail.data === null) continue;
                    attempt = runSchema.parse(detail.data);
                  }
                  records.push(runRecord(attempt, workflow));
                  for (const job of await pages(
                    endpoint + "/jobs?per_page=100",
                    "jobs",
                    attempt.updated_at,
                  ))
                    records.push(jobRecord(job, attempt, workflow));
                }
              }
            }
          }
        } else if (name === "github.comment") {
          for (const raw of await pages("issues/comments?per_page=100&since=" + sinceDay))
            records.push(commentRecord(raw));
        } else {
          for (const raw of await pages("issues?state=all&per_page=100&since=" + sinceDay)) {
            const issue = reference
              .extend({
                updated_at: z.string(),
                pull_request: z.unknown().optional(),
              })
              .parse(raw);
            if (Date.parse(issue.updated_at) < Date.parse(state.since)) continue;
            if (name === "github.pr" && issue.pull_request) {
              const p = await page(repo + "pulls/" + issue.number);
              if (p.data !== null) {
                const files = await pages("pulls/" + issue.number + "/files?per_page=100");
                records.push(prRecord(p.data, files));
              }
            } else if (name === "github.issue.timeline" && !issue.pull_request) {
              for (const item of await pages("issues/" + issue.number + "/timeline?per_page=100")) {
                const event = timelineEvent(item);
                if (!event) continue;
                const closer =
                  event.event === "closed" && !event.commit
                    ? await lookupCloser(z.object({ node_id: z.string() }).parse(item).node_id)
                    : { commit: event.commit, pr: null };
                const prs = closer.pr
                  ? [closer.pr]
                  : closer.commit
                    ? (await pages("commits/" + closer.commit + "/pulls?per_page=100")).map(
                        (p) => reference.parse(p).number,
                      )
                    : [];
                records.push(
                  timelineRecord(issue.number, { ...event, commit: closer.commit }, prs),
                );
              }
            } else if (name === "github.issue" && !issue.pull_request) {
              const blockers = await pages(
                "issues/" + issue.number + "/dependencies/blocked_by?per_page=100",
              );
              records.push(issueRecord(raw, blockers));
            }
          }
        }
        // Only stable URLs benefit from validators on the next cycle.
        for (const key of Object.keys(pending.tags))
          if (key.includes("since=") && !decodeURIComponent(key).includes(sinceDay))
            delete pending.tags[key];
        return records;
      },
    };
  });
}
