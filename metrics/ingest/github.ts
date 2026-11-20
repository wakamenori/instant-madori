import { z } from "zod";
import { candidate } from "./polled.ts";
const number = z.int(),
  str = z.string(),
  nullable = str.nullable();
export const reference = z.object({ number });
const timestamped = { created_at: str, closed_at: nullable, state: str };
const labels = z.array(z.object({ name: str })).transform((rows) => rows.map((r) => r.name).sort());
const issueSchema = reference.extend({
  ...timestamped,
  title: str,
  milestone: reference.extend({ title: str }).nullable(),
  labels,
});
const prSchema = reference.extend({
  ...timestamped,
  merged_at: nullable,
  head: z.object({ ref: str, sha: str }),
  base: z.object({ ref: str }),
  merge_commit_sha: nullable,
  additions: number,
  deletions: number,
  changed_files: number,
  labels,
  body: nullable,
  mergeable_state: str.nullable().optional(),
});
const commentSchema = z.object({
  id: number,
  body: str,
  user: z.object({ login: str }),
  issue_url: str,
  created_at: str,
});
const markers = {
  staging_occupy_end: /占有.{0,12}(?:解除|解放|終了)|(?:解除|解放).{0,12}占有/u,
  staging_occupy_start: /占有.{0,12}(?:開始|します|開始しました)|(?:開始).{0,12}占有/u,
  verdict_pass: /\bPASS\b/u,
  verdict_fail: /\bFAIL\b/u,
  merged: /マージしました|\bmerged\b/iu,
};
export function issueRecord(data: unknown, blockers: unknown[]) {
  const issue = issueSchema.parse(data);
  return candidate("github.issue", issue.number, issue.created_at, {
    ...issue,
    blocked_by: z.array(reference.extend({ state: str })).parse(blockers),
  });
}
export function prRecord(data: unknown) {
  const { body, head, base, mergeable_state, ...pr } = prSchema.parse(data);
  return candidate("github.pr", pr.number, pr.created_at, {
    ...pr,
    mergeable_state: mergeable_state ?? null,
    head_ref: head.ref,
    head_sha: head.sha,
    base_ref: base.ref,
    closes: [
      ...new Set(
        Array.from((body ?? "").matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/giu), (m) =>
          Number(m[1]),
        ),
      ),
    ],
  });
}
export function commentRecord(data: unknown) {
  const c = commentSchema.parse(data);
  return candidate("github.comment", c.id, c.created_at, {
    created_at: c.created_at,
    issue_or_pr: number.parse(Number(c.issue_url.split("/").at(-1))),
    author: c.user.login,
    markers: Object.entries(markers)
      .filter(([, re]) => re.test(c.body))
      .map(([m]) => m),
    body_length: c.body.length,
  });
}
export const runSchema = z.object({
  id: number,
  event: str,
  head_sha: str,
  head_branch: nullable,
  pull_requests: z.array(reference),
  created_at: str,
  updated_at: str,
  conclusion: nullable,
});
const jobSchema = z.object({
  id: number,
  run_attempt: number,
  status: str,
  conclusion: nullable,
  created_at: str,
  started_at: nullable,
  completed_at: nullable,
  runner_name: nullable,
  steps: z
    .array(
      z.object({ name: str, conclusion: nullable, started_at: nullable, completed_at: nullable }),
    )
    .default([]),
});
export function jobRecord(data: unknown, run: z.infer<typeof runSchema>, workflow: string) {
  const { id, ...job } = jobSchema.parse(data);
  return candidate("github.actions.job", id, job.created_at, {
    ...job,
    workflow,
    run_id: run.id,
    run_created_at: run.created_at,
    run_conclusion: run.conclusion,
    event: run.event,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    pr_numbers: run.pull_requests.map((p) => p.number),
  });
}
