import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const sql = readFileSync(new URL("../models/marts/06-capacity.sql", import.meta.url), "utf8");
const stage = "平屋の生成・変更・保存";
const infrastructure = "開発基盤";
const undated = "期限なし";
const afterDelivery = "初回提供の後";

type Snapshot = {
  milestone: string | null;
  throughput?: boolean;
  blockedBy?: number[];
  staging?: boolean;
};
type Version = Snapshot & { from: number };
type Issue = Snapshot & {
  number: number;
  createdAt: number;
  observedAt?: number;
  closedAt?: number;
  versions?: Version[];
};
type Minute = { at: number; owners: number; worked?: number[] };
type Fixture = { issues: Issue[]; minutes: Minute[] };

function buildCapacity(db: DatabaseSync, model: string, { issues, minutes }: Fixture) {
  db.exec(`
    CREATE TABLE stg_github_issue_history(
      number INTEGER, created_at TEXT, blocked_by TEXT, shared_resources TEXT,
      milestone TEXT, labels TEXT, valid_from TEXT, valid_to TEXT
    );
    CREATE TABLE stg_github_issue(number INTEGER, created_at TEXT, closed_at TEXT);
    CREATE TABLE stg_github_issue_timeline(issue INTEGER, created_at TEXT, id INTEGER, event TEXT);
    CREATE TABLE work_item(issue INTEGER);
    CREATE TABLE mart_active_minute(minute INTEGER, owners INTEGER, feature_minutes INTEGER);
    CREATE TABLE issue_minute(issue INTEGER, minute INTEGER);
  `);
  const addHistory = db.prepare("INSERT INTO stg_github_issue_history VALUES(?,?,?,?,?,?,?,?)");
  const addCurrent = db.prepare("INSERT INTO stg_github_issue VALUES(?,?,?)");
  const addItem = db.prepare("INSERT INTO work_item VALUES(?)");
  const addMinute = db.prepare("INSERT INTO mart_active_minute VALUES(?,?,0)");
  const addWorked = db.prepare("INSERT INTO issue_minute VALUES(?,?)");
  const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();

  for (const issue of issues) {
    const { number, createdAt, observedAt = createdAt, closedAt, versions = [] } = issue;
    addCurrent.run(number, iso(createdAt), closedAt === undefined ? null : iso(closedAt));
    addItem.run(number);
    const history = [{ ...issue, from: observedAt }, ...versions];
    for (const [index, snapshot] of history.entries()) {
      const next = history[index + 1];
      addHistory.run(
        number,
        iso(createdAt),
        JSON.stringify((snapshot.blockedBy ?? []).map((blocker) => ({ number: blocker }))),
        JSON.stringify(snapshot.staging ? ["staging を占有する"] : []),
        snapshot.milestone === null ? null : JSON.stringify({ title: snapshot.milestone }),
        JSON.stringify(snapshot.throughput ? ["スループット"] : []),
        iso(snapshot.from),
        next ? iso(next.from) : null,
      );
    }
  }
  for (const { at, owners, worked = [] } of minutes) {
    addMinute.run(at, owners);
    for (const issue of worked) addWorked.run(issue, at);
  }
  db.exec(model);
}

function policyTime() {
  using db = new DatabaseSync(":memory:");
  buildCapacity(db, sql, { issues: [], minutes: [] });
  const row = db.prepare("SELECT unixepoch(effective) AS time FROM dispatch_policy").get();
  assert.ok(typeof row?.time === "number");
  return row.time;
}

const time = policyTime();
const before = Math.ceil(time / 60) * 60 - 60;
const after = before + 60;
const createdAt = before - 600;

function candidateRows(db: DatabaseSync, minute: number) {
  return db
    .prepare(
      "SELECT number,lane,selectable FROM mart_slot_candidate WHERE minute=? ORDER BY number",
    )
    .all(minute)
    .map((row) => [row.number, row.lane, row.selectable]);
}

function emptySlots(db: DatabaseSync, minute: number) {
  return db
    .prepare("SELECT reason,slots FROM mart_empty_slot WHERE minute=? ORDER BY reason")
    .all(minute)
    .map((row) => [row.reason, row.slots]);
}

void test("all pre-policy empty slot rows match the frozen SQL, including late first observation", () => {
  const frozen = execFileSync("git", ["show", "78f78bd98:metrics/models/marts/06-capacity.sql"], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  });
  const lateObservation = {
    number: 7,
    createdAt,
    milestone: afterDelivery,
    observedAt: after + 60,
  };
  const fixtures: Fixture[] = [
    {
      issues: [
        { number: 1, createdAt, milestone: infrastructure },
        { number: 2, createdAt, milestone: stage, staging: true },
        { number: 3, createdAt, milestone: infrastructure, staging: true },
        { number: 4, createdAt, milestone: undated, staging: true },
        { number: 5, createdAt, milestone: null, staging: true },
        { number: 6, createdAt, milestone: afterDelivery, staging: true },
        lateObservation,
      ],
      minutes: [1, 2, 3, 4].map((owners) => ({
        at: before - (owners - 1) * 60,
        owners,
        worked: [1],
      })),
    },
    {
      issues: [lateObservation],
      minutes: [{ at: before, owners: 4 }],
    },
  ];
  for (const fixture of fixtures) {
    using previous = new DatabaseSync(":memory:");
    using current = new DatabaseSync(":memory:");
    buildCapacity(previous, frozen, fixture);
    buildCapacity(current, sql, fixture);
    const rows = (db: DatabaseSync) =>
      db.prepare("SELECT * FROM mart_empty_slot WHERE minute<? ORDER BY minute,reason").all(time);
    assert.deepEqual(rows(current), rows(previous));
  }
});

void test("the policy narrows candidates and caps infrastructure already in progress", () => {
  using db = new DatabaseSync(":memory:");
  buildCapacity(db, sql, {
    issues: [
      { number: 1, createdAt, milestone: infrastructure },
      { number: 2, createdAt, milestone: stage },
      { number: 3, createdAt, milestone: infrastructure },
      { number: 4, createdAt, milestone: infrastructure, throughput: true },
      { number: 5, createdAt, milestone: infrastructure },
      { number: 6, createdAt, milestone: infrastructure, blockedBy: [5] },
      { number: 7, createdAt, milestone: stage, blockedBy: [6] },
      { number: 8, createdAt, milestone: undated },
      { number: 9, createdAt, milestone: afterDelivery },
      { number: 10, createdAt, milestone: null },
    ],
    minutes: [before, after].map((at) => ({ at, owners: 3, worked: [1] })),
  });
  assert.deepEqual(candidateRows(db, before), [
    [2, "stage", 1],
    [3, "infrastructure", 1],
    [4, "infrastructure", 1],
    [5, "infrastructure", 1],
    [8, "parked", 1],
    [9, "parked", 1],
    [10, "unplaced", 1],
  ]);
  assert.deepEqual(emptySlots(db, before), [["awaiting_dispatch", 2]]);
  assert.deepEqual(candidateRows(db, after), [
    [2, "stage", 1],
    [4, "infrastructure", 0],
    [5, "infrastructure", 0],
  ]);
  assert.deepEqual(emptySlots(db, after), [
    ["awaiting_dispatch", 1],
    ["resource_limit", 1],
  ]);
});

void test("parked, unplaced, and non-target infrastructure leave no ready issue", () => {
  using db = new DatabaseSync(":memory:");
  buildCapacity(db, sql, {
    issues: [
      { number: 1, createdAt, milestone: undated, throughput: true },
      { number: 2, createdAt, milestone: afterDelivery },
      { number: 3, createdAt, milestone: null },
      { number: 4, createdAt, milestone: infrastructure },
    ],
    minutes: [{ at: after, owners: 1 }],
  });
  assert.deepEqual(candidateRows(db, after), []);
  assert.deepEqual(emptySlots(db, after), [["no_ready_issue", 4]]);
});

for (const change of ["middle closes", "stage moves", "stage drops its dependency"] as const) {
  void test(`the infrastructure feeder stops qualifying when the ${change}`, () => {
    using db = new DatabaseSync(":memory:");
    const changedAt = after + 60;
    buildCapacity(db, sql, {
      issues: [
        { number: 1, createdAt, milestone: infrastructure },
        {
          number: 2,
          createdAt,
          milestone: infrastructure,
          blockedBy: [1],
          ...(change === "middle closes" ? { closedAt: changedAt } : {}),
        },
        {
          number: 3,
          createdAt,
          milestone: stage,
          blockedBy: [2],
          versions:
            change === "stage moves"
              ? [{ from: changedAt, milestone: afterDelivery, blockedBy: [2] }]
              : change === "stage drops its dependency"
                ? [{ from: changedAt, milestone: stage }]
                : [],
        },
      ],
      minutes: [after, changedAt].map((at) => ({ at, owners: 3 })),
    });
    assert.deepEqual(candidateRows(db, after), [[1, "infrastructure", 1]]);
    assert.deepEqual(
      candidateRows(db, changedAt),
      change === "stage moves" ? [] : [[3, "stage", 1]],
    );
  });
}

void test("the milestone and throughput label take effect together at the new version", () => {
  using db = new DatabaseSync(":memory:");
  const changedAt = after + 60;
  buildCapacity(db, sql, {
    issues: [
      {
        number: 1,
        createdAt,
        milestone: undated,
        versions: [{ from: changedAt, milestone: infrastructure, throughput: true }],
      },
    ],
    minutes: [after, changedAt].map((at) => ({ at, owners: 4 })),
  });
  assert.deepEqual(candidateRows(db, after), []);
  assert.deepEqual(candidateRows(db, changedAt), [[1, "infrastructure", 1]]);
  assert.deepEqual(emptySlots(db, changedAt), [["awaiting_dispatch", 1]]);
});

void test("one free slot can be filled by either of two selectable candidates", () => {
  using db = new DatabaseSync(":memory:");
  buildCapacity(db, sql, {
    issues: [
      { number: 1, createdAt, milestone: stage },
      { number: 2, createdAt, milestone: infrastructure, throughput: true },
    ],
    minutes: [{ at: after, owners: 4 }],
  });
  assert.deepEqual(candidateRows(db, after), [
    [1, "stage", 1],
    [2, "infrastructure", 1],
  ]);
  assert.deepEqual(emptySlots(db, after), [["awaiting_dispatch", 1]]);
});

void test("giving staging to a stage candidate leaves room for a non-staging infrastructure target", () => {
  using db = new DatabaseSync(":memory:");
  buildCapacity(db, sql, {
    issues: [
      { number: 1, createdAt, milestone: infrastructure, throughput: true, staging: true },
      { number: 2, createdAt, milestone: infrastructure, throughput: true },
      { number: 3, createdAt, milestone: stage, staging: true },
    ],
    minutes: [{ at: after, owners: 3 }],
  });
  assert.deepEqual(candidateRows(db, after), [
    [1, "infrastructure", 0],
    [2, "infrastructure", 1],
    [3, "stage", 1],
  ]);
  assert.deepEqual(emptySlots(db, after), [["awaiting_dispatch", 2]]);
});
