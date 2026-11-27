import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdin = argv.includes("--input") ? readFileSync(0, "utf8") : "";
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, stdin }) + "\n");
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const number = argv.join(" ").match(/(?:issues\/|pr view )(\d+)/)?.[1];
const path = `repos/{owner}/{repo}/issues/${number}`;
const deps = path + "/dependencies/blocked_by";
const matches = (...args) => args.length === argv.length && args.every((arg, i) => arg === argv[i]);
const issue = state.issues?.[number];
function missing() {
  console.error("HTTP 404");
  process.exit(1);
}
const actions = "repos/{owner}/{repo}/actions/";
const runsSha = argv[1]?.match(/head_sha=([0-9a-f]{40})&per_page=100$/)?.[1];
const jobsId = argv[1]?.match(/runs\/(\d+)\/jobs$/)?.[1];
if (
  argv[3]?.startsWith("query=") &&
  (matches("api", "graphql", "-f", argv[3]) ||
    (matches("api", "graphql", "-f", argv[3], "-f", argv[5]) && argv[5].startsWith("cursor=")))
) {
  const cursor = argv[5]?.slice("cursor=".length) ?? "";
  const page = state.graphql?.[cursor];
  if (!page) missing();
  console.log(JSON.stringify({ data: { repository: { issues: page } } }));
} else if (
  matches("api", actions + `workflows/deploy-staging.yml/runs?head_sha=${runsSha}&per_page=100`)
) {
  console.log(JSON.stringify({ workflow_runs: state.runs?.[runsSha] ?? [] }));
} else if (matches("api", actions + `runs/${jobsId}/jobs`)) {
  console.log(JSON.stringify({ jobs: state.jobs?.[jobsId] ?? [] }));
} else if (matches("pr", "view", number, "--json", "mergeCommit")) {
  if (!state.prs?.[number]) missing();
  console.log(JSON.stringify(state.prs[number]));
} else if (matches("api", path)) {
  if (!issue) missing();
  console.log(JSON.stringify({ number: Number(number), body: issue.body, id: issue.id }));
} else if (matches("api", path, "--jq", ".id")) {
  if (!issue) missing();
  console.log(issue.id);
} else if (matches("api", "--paginate", deps + "?per_page=100", "--jq", ".[].number")) {
  if (!issue) missing();
  for (const blocker of issue.blockedBy) console.log(blocker);
} else if (matches("api", "-X", "POST", deps, "-F", argv[5]) && /^issue_id=\d+$/.test(argv[5])) {
  const blocker = Object.entries(state.issues).find(
    ([, value]) => "issue_id=" + value.id === argv[5],
  );
  if (!issue || !blocker) missing();
  if (!state.faults?.ignoreRegistrations) issue.blockedBy.push(Number(blocker[0]));
  writeFileSync(file, JSON.stringify(state));
} else if (matches("api", "-X", "PATCH", path, "--input", "-")) {
  if (!issue) missing();
  if (!state.faults?.ignoreBodyWrites) issue.body = JSON.parse(stdin).body;
  writeFileSync(file, JSON.stringify(state));
} else {
  console.error("unexpected gh call: " + JSON.stringify(argv));
  process.exitCode = 64;
}
