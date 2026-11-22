import { z } from "zod";
import { issueFacts, commentFacts } from "./github-yaml.ts";
import { candidate, verdict } from "./polled.ts";
const number = z.int(),
  str = z.string(),
  nullable = str.nullable();
export const reference = z.object({ number });
const timestamped = { created_at: str, closed_at: nullable, state: str };
const labels = z.array(z.object({ name: str })).transform((rows) => rows.map((r) => r.name).sort());
const issueSchema = reference.extend({
  ...timestamped,
  title: str,
  body: nullable.optional(),
  milestone: reference.extend({ title: str }).nullable(),
  labels,
});
const prSchema = reference.extend({
  ...timestamped,
  user: z.object({ type: str }).optional(),
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
  updated_at: str.optional(),
  created_at: str,
});
// Bump the version to replay GitHub comments whenever their extracted fields change.
export const commentRulesVersion = "yaml-5";
const markers = {
  staging_occupy_start:
    /(?:^指揮役：staging の占有を始めた|(?:^|[。、])この Issue の担当の staging の占有を、今から始める)(?=[。（]|$)/u,
  staging_occupy_end:
    /(?:^指揮役：staging の占有を終えた|(?:^|：)担当が staging の確認を終えたので、この Issue の担当の staging の占有を終える)(?=[。（]|$)|^指揮役：#\d+ の担当の staging の占有が終わり、終わっていない deploy-staging/u,
  merged: /マージしました|\bmerged\b/iu,
};
export const blockerSchema = reference.extend({ state: str });
export function issueRecord(data: unknown, blockers: unknown[]) {
  const { body, ...issue } = issueSchema.parse(data);
  return candidate("github.issue", issue.number, issue.created_at, {
    ...issue,
    ...issueFacts(body ?? "", issue.labels),
    blocked_by: z.array(blockerSchema).parse(blockers),
  });
}
export const changedFile = z.object({
  filename: str,
  previous_filename: str.nullable().default(null),
  status: str,
});
export function prRecord(data: unknown, rows: unknown[]) {
  const { body, head, base, user, mergeable_state, ...pr } = prSchema.parse(data);
  const files = z.array(changedFile).parse(rows);
  return candidate("github.pr", pr.number, pr.created_at, {
    ...pr,
    creator_type: user?.type ?? null,
    files,
    files_complete: files.length === pr.changed_files,
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
export function commentRecord(data: unknown, labels: string[] = []) {
  const c = commentSchema.parse(data);
  const fields = commentFacts(c.body, labels);
  const legacy = fields.length
    ? []
    : Object.entries(markers)
        .filter(
          ([marker, re]) => (marker === "merged" && c.body.includes(marker)) || re.test(c.body),
        )
        .map(([marker]) => marker);
  const decision = fields.length
    ? null
    : verdict(c.body.replaceAll(/verdict_(pass|fail)/gu, (_, word: string) => word.toUpperCase()));
  if (decision) legacy.push("verdict_" + decision.toLowerCase());
  return candidate("github.comment", c.id, c.created_at, {
    created_at: c.created_at,
    issue_or_pr: number.parse(Number(c.issue_url.split("/").at(-1))),
    author: c.user.login,
    markers: legacy,
    fields,
    updated_at: c.updated_at ?? c.created_at,
    rules_version: commentRulesVersion,
    body_length: c.body.length,
  });
}
export const runSchema = z.object({
  id: number,
  event: str,
  run_attempt: number.positive(),
  status: str,
  run_started_at: nullable.optional(),
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
  name: str,
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

export function timelineEvent(raw: unknown) {
  const event = z.object({ event: str }).parse(raw).event;
  if (!["closed", "reopened", "labeled", "unlabeled"].includes(event)) return null;
  const common = z.object({ id: number, created_at: str });
  const base = common.parse(raw);
  const label =
    event === "labeled" || event === "unlabeled"
      ? z.object({ label: z.object({ name: str }) }).parse(raw).label.name
      : null;
  const commit =
    event === "closed"
      ? z.object({ commit_id: str.regex(/^[0-9a-f]{40}$/u).nullable() }).parse(raw).commit_id
      : null;
  return { ...base, event, label, commit };
}
const commitRef = z.object({ oid: str });
const closerSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("Commit"), oid: str }),
  z.object({
    __typename: z.literal("PullRequest"),
    number,
    repository: z.object({ nameWithOwner: str }),
    mergeCommit: commitRef.nullable(),
  }),
]);
export function closureReference(response: unknown) {
  const result = z
    .object({
      errors: z.never().optional(),
      data: z.object({ node: z.object({ closer: closerSchema.nullable() }) }),
    })
    .parse(response);
  const closer = result.data.node.closer;
  if (closer?.__typename === "Commit") return { commit: closer.oid, pr: null };
  if (
    closer?.__typename === "PullRequest" &&
    closer.repository.nameWithOwner.toLowerCase() === "wakamenori/instant-madori"
  )
    return { commit: closer.mergeCommit?.oid ?? null, pr: closer.number };
  return { commit: null, pr: null };
}
export function timelineRecord(
  issue: number,
  row: NonNullable<ReturnType<typeof timelineEvent>>,
  prs: number[],
) {
  return candidate("github.issue.timeline", row.id, row.created_at, { ...row, issue, prs });
}
export function runRecord(run: z.infer<typeof runSchema>, workflow: string) {
  return candidate(
    "github.actions.attempt",
    run.id + "/" + run.run_attempt,
    run.run_started_at ?? run.created_at,
    {
      run_id: run.id,
      run_attempt: run.run_attempt,
      workflow,
      head_sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      created_at: run.created_at,
      started_at: run.run_started_at ?? null,
      updated_at: run.updated_at,
    },
  );
}
