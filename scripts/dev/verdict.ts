import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse, Scalar, stringify } from "yaml";
import { z } from "zod";

const repository = "wakamenori/instant-madori";
const checks = ["検査", "振る舞い", "地図", "差分", "終わった証拠"] as const;
type Check = (typeof checks)[number];
const positive = z.string().regex(/^\d+$/u).pipe(z.coerce.number<string>().int().positive());
const prNumber = positive.brand<"PrNumber">();
const attemptNumber = positive.brand<"Attempt">();
const commitSha = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]+$/u)
  .brand<"CommitSha">();
type PrNumber = z.output<typeof prNumber>;
type Attempt = z.output<typeof attemptNumber>;
type CommitSha = z.output<typeof commitSha>;
type Outcome =
  | { readonly verdict: "PASS" }
  | { readonly verdict: "FAIL"; readonly failed: readonly [Check, ...Check[]] };
interface Verdict {
  readonly pr: PrNumber;
  readonly head: CommitSha;
  readonly attempt: Attempt;
  readonly outcome: Outcome;
  readonly decidedAt: string;
}

const usage =
  "Usage: node scripts/dev/verdict.ts --pr <number> --head <sha> --attempt <n> (--pass | --fail <check> [--fail <check>]...) --report <file> [--dry-run]";
class UsageError extends Error {}
const command = z.object({
  pr: prNumber,
  head: commitSha,
  attempt: attemptNumber,
  report: z.string().min(1),
  pass: z.boolean().optional(),
  fail: z.array(z.enum(checks)).default([]),
  "dry-run": z.boolean().default(false),
});

export function parseCommand(argv: string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        pr: { type: "string" },
        head: { type: "string" },
        attempt: { type: "string" },
        report: { type: "string" },
        pass: { type: "boolean" },
        fail: { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const parsed = command.safeParse(values);
  if (!parsed.success) throw new UsageError(z.prettifyError(parsed.error));
  const { pr, head, attempt, report, pass, fail, "dry-run": dryRun } = parsed.data;
  const [first, ...rest] = fail;
  if (Boolean(pass) === (first !== undefined))
    throw new UsageError("Specify either --pass or one or more --fail checks");
  if (new Set(fail).size !== fail.length) throw new UsageError("Repeated --fail check");
  const outcome: Outcome =
    first === undefined ? { verdict: "PASS" } : { verdict: "FAIL", failed: [first, ...rest] };
  return { pr, head, attempt, report, dryRun, outcome };
}

function record(verdict: Verdict, attempt: boolean) {
  const head = new Scalar(verdict.head);
  head.type = Scalar.QUOTE_DOUBLE;
  const { outcome } = verdict;
  const yaml = stringify({
    ...(attempt ? { attempt: verdict.attempt } : {}),
    head,
    verdict: outcome.verdict,
    decided_at: verdict.decidedAt,
    failed_checks: outcome.verdict === "FAIL" ? outcome.failed : [],
  });
  return "```yaml\n" + yaml + "```\n";
}

export function renderComment(verdict: Verdict, report: string) {
  return record(verdict, true) + "\n" + report;
}

export function renderMessage(verdict: Verdict, url: string, state: string) {
  return record(verdict, false) + "\n" + url + "\nverify " + state + " on " + verdict.head;
}

export function renderStatus({ attempt, outcome }: Verdict, targetUrl: string | undefined) {
  return {
    state: outcome.verdict === "PASS" ? "success" : "failure",
    context: "verify",
    description:
      `attempt ${attempt}: ${outcome.verdict}` +
      (outcome.verdict === "FAIL" ? " " + outcome.failed.join(", ") : ""),
    target_url: targetUrl,
  } as const;
}

const commentLink = z.object({ html_url: z.url() });
const comment = commentLink.extend({ body: z.string() });
const identity = z.object({ attempt: z.int(), head: z.string() });
export function existingComment(
  comments: readonly z.output<typeof comment>[],
  verdict: Verdict,
): { kind: "reuse"; url: string } | { kind: "none" } | { kind: "conflict" } {
  const { outcome } = verdict;
  const sameOutcome = z.object({
    verdict: z.literal(outcome.verdict),
    failed_checks: z.array(z.enum(checks)).refine((items) => {
      const expected = outcome.verdict === "FAIL" ? outcome.failed : [];
      return items.length === expected.length && items.every((item, i) => item === expected[i]);
    }),
  });
  let url;
  for (const { html_url, body } of comments) {
    const block = /^```yaml[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/mu.exec(body.trimStart());
    if (block?.index !== 0 || block[1] === undefined) continue;
    let record: unknown;
    try {
      record = parse(block[1], { maxAliasCount: 0 });
    } catch {
      continue;
    }
    const key = identity.safeParse(record);
    if (!key.success || key.data.attempt !== verdict.attempt || key.data.head !== verdict.head)
      continue;
    if (!sameOutcome.safeParse(record).success) return { kind: "conflict" };
    url ??= html_url;
  }
  return url === undefined ? { kind: "none" } : { kind: "reuse", url };
}

function gh(args: string[], input?: string) {
  const result = spawnSync("gh", args, {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GH_REPO: repository },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `gh exited with ${result.status}`);
  return result.stdout;
}

function run(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return;
  }
  const args = parseCommand(argv);
  let report;
  try {
    report = readFileSync(args.report, "utf8");
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (!report.trim()) throw new UsageError("Report is blank: " + args.report);
  const verdict: Verdict = {
    ...args,
    decidedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };
  const body = renderComment(verdict, report);
  if (args.dryRun) {
    const status = renderStatus(verdict, undefined);
    console.log(
      JSON.stringify({
        comment: body,
        status,
        message: renderMessage(verdict, "<comment URL>", status.state),
      }),
    );
    return;
  }
  const { headRefOid } = z
    .object({ headRefOid: commitSha })
    .parse(JSON.parse(gh(["pr", "view", String(args.pr), "--json", "headRefOid"])));
  if (headRefOid !== args.head)
    throw new Error(`PR head ${headRefOid} differs from verified head ${args.head}`);
  const endpoint = `repos/{owner}/{repo}/issues/${args.pr}/comments`;
  const pages = z
    .array(z.array(comment))
    .parse(JSON.parse(gh(["api", "--paginate", "--slurp", endpoint])));
  const match = existingComment(pages.flat(), verdict);
  if (match.kind === "conflict")
    throw new Error(`Conflicting verdict for attempt ${args.attempt} on ${args.head}`);
  const url =
    match.kind === "reuse"
      ? match.url
      : commentLink.parse(
          JSON.parse(gh(["api", endpoint, "--input", "-"], JSON.stringify({ body }))),
        ).html_url;
  const status = renderStatus(verdict, url);
  gh(["api", `repos/{owner}/{repo}/statuses/${args.head}`, "--input", "-"], JSON.stringify(status));
  console.log(renderMessage(verdict, url, status.state));
}

if (import.meta.main) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError) console.error(usage);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
