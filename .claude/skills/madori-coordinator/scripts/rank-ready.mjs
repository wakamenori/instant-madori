import { execFileSync } from "node:child_process";

const query = `query($cursor: String) {
  repository(owner: "wakamenori", name: "instant-madori") {
    issues(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title milestone { number title }
        blockedBy(first: 50) { nodes { number state } }
        blocking(first: 50) { nodes { number state } }
      }
    }
  }
}`;

const issues = new Map();
let cursor = null;
do {
  const args = ["api", "graphql", "-f", `query=${query}`];
  if (cursor) args.push("-f", `cursor=${cursor}`);
  const output = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const page = JSON.parse(output).data.repository.issues;
  for (const issue of page.nodes) issues.set(issue.number, issue);
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (cursor);

const chains = new Map();
const chain = (number, seen = new Set()) => {
  if (chains.has(number)) return chains.get(number);
  if (seen.has(number)) return 0;
  seen.add(number);
  const next = issues
    .get(number)
    .blocking.nodes.filter((b) => b.state === "OPEN" && issues.has(b.number));
  const length = next.length ? 1 + Math.max(...next.map((b) => chain(b.number, seen))) : 0;
  chains.set(number, length);
  return length;
};

const stage = (issue) => issue.milestone?.number ?? Number.MAX_SAFE_INTEGER;
const ready = [...issues.values()].filter(
  (issue) => !issue.blockedBy.nodes.some((b) => b.state === "OPEN"),
);
ready.sort(
  (a, b) => stage(a) - stage(b) || chain(b.number) - chain(a.number) || a.number - b.number,
);
for (const issue of ready) {
  const milestone = issue.milestone?.title ?? "-";
  console.log(
    [`#${issue.number}`, milestone, `chain=${chain(issue.number)}`, issue.title].join("\t"),
  );
}
console.log(`open=${issues.size} ready=${ready.length}`);
