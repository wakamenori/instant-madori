import { execFileSync } from "node:child_process";

const query = `query($cursor: String) {
  repository(owner: "wakamenori", name: "instant-madori") {
    issues(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title milestone { number title }
        labels(first: 20) { nodes { name } }
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

const groups = new Map([
  ["段階", []],
  ["開発基盤", []],
  ["milestone なし", []],
  ["期限なし", []],
]);
const throughput = (issue) => issue.labels.nodes.some((label) => label.name === "スループット");
const ready = [...issues.values()].filter(
  (issue) => !issue.blockedBy.nodes.some((b) => b.state === "OPEN"),
);
for (const issue of ready) {
  const title = issue.milestone?.title;
  const group = !issue.milestone
    ? "milestone なし"
    : title === "開発基盤" || title === "期限なし"
      ? title
      : "段階";
  groups.get(group).push(issue);
}
for (const [group, members] of groups) {
  if (group === "milestone なし" && !members.length) continue;
  console.log(`== ${group}`);
  members.sort(
    (a, b) =>
      (group === "段階" && a.milestone.number - b.milestone.number) ||
      throughput(b) - throughput(a) ||
      chain(b.number) - chain(a.number) ||
      a.number - b.number,
  );
  for (const issue of members) {
    console.log(
      [
        `#${issue.number}`,
        issue.milestone?.title ?? "-",
        `chain=${chain(issue.number)}`,
        throughput(issue) ? "スループット" : "-",
        issue.title,
      ].join("\t"),
    );
  }
}
console.log(`open=${issues.size} ready=${ready.length}`);
