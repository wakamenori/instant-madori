import { spawnSync } from "node:child_process";
import { z } from "zod";

const label = "staging を占有中";
const workflow = "deploy-staging.yml";
const repo = "repos/{owner}/{repo}";
const usage = "Usage: node scripts/dev/staging.ts start|end <issue>";
class UsageError extends Error {}

const issueNumber = z.int().positive().brand<"IssueNumber">();
type IssueNumber = z.output<typeof issueNumber>;
const command = z.tuple([
  z.enum(["start", "end"]),
  z.string().regex(/^\d+$/u).pipe(z.coerce.number<string>()).pipe(issueNumber),
]);
const target = z.object({ number: issueNumber, pull_request: z.unknown().optional() });
const holderPages = z.array(z.array(z.object({ number: issueNumber })));
const deployRun = z.object({ id: z.int().positive(), status: z.string(), html_url: z.url() });
const runPages = z.array(z.object({ workflow_runs: z.array(deployRun) }));
const labels = z.array(z.object({ name: z.string() }));
const comment = z.object({ html_url: z.url() });
const bodies = {
  start:
    "指揮役：staging の占有を始めた。この Issue の担当が確かめ終わるまで、ほかの Issue は staging を占有せず、デプロイを起こすマージとデプロイ（`gh workflow run`、`gh run rerun`）をしない。占有は、ラベル「staging を占有中」の付け外しで記録する。",
  end: "指揮役：staging の占有を終えた。ラベル「staging を占有中」を外した。",
};

function listHolders(holders: readonly IssueNumber[]) {
  return [...holders]
    .sort((a, b) => a - b)
    .map((n) => "#" + n)
    .join(", ");
}

function checkStart(holders: readonly IssueNumber[], runs: readonly z.output<typeof deployRun>[]) {
  const reasons = [];
  if (holders.length) reasons.push("staging is already occupied by " + listHolders(holders));
  const unfinished = runs.filter((run) => run.status !== "completed");
  if (unfinished.length) {
    reasons.push("deploy-staging runs have not finished:");
    for (const { id, status, html_url } of unfinished) reasons.push(`${id} ${status} ${html_url}`);
  }
  if (reasons.length) throw new Error(reasons.join("\n"));
}

function checkEnd(issue: IssueNumber, holders: readonly IssueNumber[]) {
  if (holders.includes(issue)) return;
  const heldBy = holders.length ? " (held by " + listHolders(holders) + ")" : "";
  throw new Error(`#${issue} does not hold the staging occupation` + heldBy);
}

function api<T>(schema: z.ZodType<T>, args: string[], input?: object): T {
  const result = spawnSync("gh", ["api", ...args], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GH_REPO: "wakamenori/instant-madori" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `gh exited with ${result.status}`);
  return schema.parse(JSON.parse(result.stdout));
}

function run(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return;
  }
  const parsed = command.safeParse(argv);
  if (!parsed.success) throw new UsageError(z.prettifyError(parsed.error));
  const [mode, issue] = parsed.data;
  const endpoint = `${repo}/issues/${issue}`;
  if (api(target, [endpoint]).pull_request != null)
    throw new Error(`#${issue} is a pull request, not an Issue`);

  const encodedLabel = encodeURIComponent(label);
  const holders = api(holderPages, [
    "--paginate",
    "--slurp",
    `${repo}/issues?labels=${encodedLabel}&state=all&per_page=100`,
  ])
    .flat()
    .map((holder) => holder.number);
  if (mode === "start") {
    const pages = api(runPages, [
      "--paginate",
      "--slurp",
      `${repo}/actions/workflows/${workflow}/runs?per_page=100`,
    ]);
    checkStart(
      holders,
      pages.flatMap((page) => page.workflow_runs),
    );
    api(labels, ["-X", "POST", endpoint + "/labels", "--input", "-"], { labels: [label] });
  } else {
    checkEnd(issue, holders);
    api(labels, ["-X", "DELETE", endpoint + "/labels/" + encodedLabel]);
  }
  console.log(
    api(comment, [endpoint + "/comments", "--input", "-"], { body: bodies[mode] }).html_url,
  );
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
