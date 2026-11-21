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
if (matches("pr", "view", number, "--json", "mergeCommit")) {
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
