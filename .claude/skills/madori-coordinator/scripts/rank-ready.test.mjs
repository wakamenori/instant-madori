import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeGitHub, isolatedEnv, runScript, tempDir } from "./testing/support.mjs";

const early = { number: 2, title: "早い段階" };
const late = { number: 6, title: "後の段階" };
const infra = { number: 7, title: "開発基盤" };
const undated = { number: 8, title: "期限なし" };
const afterDelivery = { number: 9, title: "初回提供の後" };

function rank({ tickets, blocks = [], pageSize = Math.max(tickets.length, 1) }) {
  const states = new Map(tickets.map(({ number, state = "OPEN" }) => [number, state]));
  const nodes = tickets
    .filter(({ number }) => states.get(number) === "OPEN")
    .map(({ number, milestone = null, throughput = false }) => {
      const refs = (source, target) =>
        blocks
          .filter((edge) => edge[source] === number)
          .map((edge) => ({
            number: edge[target],
            state: states.get(edge[target]) ?? "OPEN",
          }));
      return {
        number,
        title: `Issue ${number}`,
        milestone,
        labels: { nodes: throughput ? [{ name: "スループット" }] : [] },
        blockedBy: { nodes: refs(1, 0) },
        blocking: { nodes: refs(0, 1) },
      };
    });
  const graphql = {};
  for (let start = 0; start === 0 || start < nodes.length; start += pageSize) {
    const end = start + pageSize;
    graphql[start ? `page-${start}` : ""] = {
      nodes: nodes.slice(start, end),
      pageInfo: {
        hasNextPage: end < nodes.length,
        endCursor: end < nodes.length ? `page-${end}` : null,
      },
    };
  }
  const dir = tempDir();
  const { env } = fakeGitHub(dir, { graphql }, isolatedEnv(dir));
  const result = runScript("rank-ready.mjs", [], { cwd: dir, env, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd().split("\n");
}

test("omits empty groups", () => {
  assert.deepEqual(rank({ tickets: [] }), ["open=0 ready=0 parked=0"]);
});

test("merges pages and orders stage issues by milestone, throughput, chain and number", () => {
  assert.deepEqual(
    rank({
      tickets: [
        { number: 1, milestone: late, throughput: true },
        { number: 3, milestone: early },
        { number: 4, milestone: early },
        { number: 5, milestone: early, throughput: true },
        { number: 6, milestone: early },
        { number: 7, milestone: late },
        { number: 9, milestone: afterDelivery },
      ],
      blocks: [[4, 7]],
      pageSize: 4,
    }),
    [
      "== 段階",
      "#5\t早い段階\tchain=0\tスループット\tIssue 5",
      "#4\t早い段階\tchain=1\t-\tIssue 4",
      "#3\t早い段階\tchain=0\t-\tIssue 3",
      "#6\t早い段階\tchain=0\t-\tIssue 6",
      "#1\t後の段階\tchain=0\tスループット\tIssue 1",
      "open=7 ready=6 parked=1",
    ],
  );
});

test("dispatches throughput and direct or transitive stage feeders, counting parked ready issues", () => {
  assert.deepEqual(
    rank({
      tickets: [
        { number: 274, milestone: infra },
        { number: 728, milestone: infra },
        { number: 235, milestone: early },
        { number: 12, milestone: infra, throughput: true },
        { number: 13, milestone: infra, throughput: true },
        { number: 14, milestone: infra },
        { number: 15, milestone: infra },
        { number: 16, milestone: infra },
        { number: 17, milestone: undated },
        { number: 18, milestone: undated },
        { number: 19, milestone: afterDelivery },
      ],
      blocks: [
        [274, 728],
        [728, 235],
        [13, 235],
        [14, 235],
        [15, 17],
      ],
    }),
    [
      "== 開発基盤",
      "#13\t開発基盤\tchain=1\tスループット\tIssue 13",
      "#12\t開発基盤\tchain=0\tスループット\tIssue 12",
      "#274\t開発基盤\tchain=2\t塞ぐ=#235\tIssue 274",
      "#14\t開発基盤\tchain=1\t塞ぐ=#235\tIssue 14",
      "open=11 ready=8 parked=4",
    ],
  );
});

test("a closed middle issue cuts the feeder path and an unfetched open blocker prevents readiness", () => {
  assert.deepEqual(
    rank({
      tickets: [
        { number: 1, milestone: infra },
        { number: 2, milestone: infra, state: "CLOSED" },
        { number: 3, milestone: early },
        { number: 4, milestone: early },
      ],
      blocks: [
        [1, 2],
        [2, 3],
        [99, 4],
      ],
    }),
    ["== 段階", "#3\t早い段階\tchain=0\t-\tIssue 3", "open=3 ready=2 parked=1"],
  );
});

test("the chain counts an open stage successor and skips a parked successor", () => {
  assert.deepEqual(
    rank({
      tickets: [
        { number: 1, milestone: early },
        { number: 2, milestone: early },
        { number: 3, milestone: afterDelivery },
        { number: 4, milestone: late },
      ],
      blocks: [
        [1, 3],
        [2, 4],
      ],
    }),
    [
      "== 段階",
      "#2\t早い段階\tchain=1\t-\tIssue 2",
      "#1\t早い段階\tchain=0\t-\tIssue 1",
      "open=4 ready=2 parked=0",
    ],
  );
});

for (const milestone of [infra, undated]) {
  test(`reports the earliest reached stage for a feeder in ${milestone.title}`, () => {
    assert.deepEqual(
      rank({
        tickets: [
          { number: 60, milestone: late },
          { number: 10, milestone },
          { number: 11, milestone: infra },
          { number: 25, milestone: early },
          { number: 20, milestone: early },
        ],
        blocks: [
          [10, 60],
          [10, 11],
          [11, 25],
          [11, 20],
        ],
      }),
      [
        milestone === infra ? "== 開発基盤" : "== 置き場を直す",
        `#10\t${milestone.title}\tchain=2\t塞ぐ=#20\tIssue 10`,
        `open=5 ready=1 parked=${milestone === infra ? 0 : 1}`,
      ],
    );
  });
}

test("reports blocked unplaced and parked feeders under 置き場を直す", () => {
  assert.deepEqual(
    rank({
      tickets: [
        { number: 1, milestone: infra },
        { number: 2 },
        { number: 3, milestone: afterDelivery },
        { number: 4, milestone: early },
        { number: 5, milestone: infra },
      ],
      blocks: [
        [1, 3],
        [3, 4],
        [5, 2],
      ],
    }),
    [
      "== 開発基盤",
      "#1\t開発基盤\tchain=0\t塞ぐ=#4\tIssue 1",
      "== 置き場を直す",
      "#3\t初回提供の後\tchain=1\t塞ぐ=#4\tIssue 3",
      "#2\t-\tchain=0\tmilestone なし\tIssue 2",
      "open=5 ready=2 parked=1",
    ],
  );
});

test("dependency cycles terminate", () => {
  const lines = rank({
    tickets: [
      { number: 1, milestone: infra },
      { number: 2, milestone: early },
      { number: 3, milestone: infra },
    ],
    blocks: [
      [1, 2],
      [2, 3],
      [3, 2],
    ],
  });
  assert.equal(lines[0], "== 開発基盤");
  assert.match(lines[1], /^#1\t開発基盤\tchain=\d+\t塞ぐ=#2\tIssue 1$/);
  assert.equal(lines[2], "open=3 ready=1 parked=0");
});
