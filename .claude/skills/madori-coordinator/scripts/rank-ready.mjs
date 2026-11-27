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

const permanentLanes = new Map([
  ["開発基盤", "infrastructure"],
  ["期限なし", "parked"],
  ["初回提供の後", "parked"],
]);

function isConnection(connection, isNode) {
  return Array.isArray(connection?.nodes) && connection.nodes.every(isNode);
}

function isIssueRef(node) {
  return Number.isInteger(node?.number) && ["OPEN", "CLOSED"].includes(node.state);
}

function isIssue(node) {
  return (
    Number.isInteger(node?.number) &&
    typeof node.title === "string" &&
    (node.milestone === null ||
      (Number.isInteger(node.milestone?.number) && typeof node.milestone.title === "string")) &&
    isConnection(node.labels, (label) => typeof label?.name === "string") &&
    isConnection(node.blockedBy, isIssueRef) &&
    isConnection(node.blocking, isIssueRef)
  );
}

const issues = new Map();
let cursor = null;
do {
  const args = ["api", "graphql", "-f", `query=${query}`];
  if (cursor) args.push("-f", `cursor=${cursor}`);
  const output = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const page = JSON.parse(output)?.data?.repository?.issues;
  if (
    !isConnection(page, isIssue) ||
    typeof page.pageInfo?.hasNextPage !== "boolean" ||
    (page.pageInfo.hasNextPage &&
      (typeof page.pageInfo.endCursor !== "string" || !page.pageInfo.endCursor))
  ) {
    throw new Error("Invalid GitHub issues page");
  }
  for (const issue of page.nodes) {
    const lane = issue.milestone
      ? (permanentLanes.get(issue.milestone.title) ?? "stage")
      : "unplaced";
    issues.set(issue.number, {
      ...issue,
      lane,
      throughput: issue.labels.nodes.some((label) => label.name === "スループット"),
    });
  }
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (cursor);

const open = [...issues.values()];
const stageOrder = (a, b) => a.milestone.number - b.milestone.number;
const stageSeeds = open
  .filter((issue) => issue.lane === "stage")
  .sort((a, b) => stageOrder(a, b) || a.number - b.number);
const feederRoots = new Map();
for (const seed of stageSeeds) {
  if (feederRoots.has(seed.number)) continue;
  const pending = [seed];
  while (pending.length) {
    const issue = pending.pop();
    for (const blocker of issue.blockedBy.nodes) {
      if (blocker.state !== "OPEN" || feederRoots.has(blocker.number)) continue;
      const openBlocker = issues.get(blocker.number);
      if (!openBlocker) continue;
      feederRoots.set(blocker.number, seed.number);
      pending.push(openBlocker);
    }
  }
}

const chains = new Map();
const chain = (number, seen = new Set()) => {
  if (chains.has(number)) return chains.get(number);
  if (seen.has(number)) return 0;
  seen.add(number);
  const next = issues.get(number).blocking.nodes.filter((b) => {
    const target = issues.get(b.number);
    return b.state === "OPEN" && target && target.lane !== "parked";
  });
  const length = next.length ? 1 + Math.max(...next.map((b) => chain(b.number, seen))) : 0;
  chains.set(number, length);
  return length;
};

const ready = open.filter((issue) => !issue.blockedBy.nodes.some((b) => b.state === "OPEN"));
const stage = ready.filter((issue) => issue.lane === "stage");
const isInfrastructureTarget = (issue) => issue.throughput || feederRoots.has(issue.number);
const infrastructure = ready.filter(
  (issue) => issue.lane === "infrastructure" && isInfrastructureTarget(issue),
);
const misplaced = open.filter(
  (issue) =>
    issue.lane === "unplaced" || (issue.lane === "parked" && feederRoots.has(issue.number)),
);
const parked = ready.filter(
  (issue) =>
    issue.lane === "parked" || (issue.lane === "infrastructure" && !isInfrastructureTarget(issue)),
).length;

const feederReason = (issue) => `塞ぐ=#${feederRoots.get(issue.number)}`;
const groups = [
  ["段階", stage, (issue) => (issue.throughput ? "スループット" : "-")],
  [
    "開発基盤",
    infrastructure,
    (issue) => (issue.throughput ? "スループット" : feederReason(issue)),
  ],
  [
    "置き場を直す",
    misplaced,
    (issue) => (issue.lane === "unplaced" ? "milestone なし" : feederReason(issue)),
  ],
];
for (const [group, members, reason] of groups) {
  if (!members.length) continue;
  console.log(`== ${group}`);
  members.sort(
    (a, b) =>
      (group === "段階" && stageOrder(a, b)) ||
      b.throughput - a.throughput ||
      chain(b.number) - chain(a.number) ||
      a.number - b.number,
  );
  for (const issue of members) {
    console.log(
      [
        `#${issue.number}`,
        issue.milestone?.title ?? "-",
        `chain=${chain(issue.number)}`,
        reason(issue),
        issue.title,
      ].join("\t"),
    );
  }
}
console.log(`open=${issues.size} ready=${ready.length} parked=${parked}`);
