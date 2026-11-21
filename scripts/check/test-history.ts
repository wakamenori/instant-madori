import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { readArtifact, type TestResult } from "./test-results.ts";

type Run = {
  workflow: string;
  runId: number;
  attempt: number;
  headSha: string;
  headBranch: string;
};
type Observation = Run & Pick<TestResult, "outcome">;
type Verdict =
  | { kind: "flaky"; evidence: string }
  | { kind: "failing" }
  | { kind: "suspect"; branches: string[] }
  | { kind: "branch-local"; branch: string }
  | { kind: "stable" };
function runLabel(o: Observation) {
  return `${o.workflow} ${o.runId}/${o.attempt}`;
}
export function verdict(observations: Observation[]): Verdict {
  const passes = observations.filter((o) => o.outcome === "pass");
  const fails = observations.filter((o) => o.outcome === "fail");
  for (const fail of fails) {
    const pass = passes.find((o) => o.headSha === fail.headSha);
    if (pass)
      return {
        kind: "flaky",
        evidence: `${fail.headSha}: pass ${runLabel(pass)}, fail ${runLabel(fail)}`,
      };
  }
  const mainFails = fails.filter((o) => o.headBranch === "main");
  if (mainFails.length && passes.some((o) => o.headBranch === "main"))
    return { kind: "flaky", evidence: "main failures: " + mainFails.map(runLabel).join(", ") };
  if (!fails.length) return { kind: "stable" };
  if (!passes.length) return { kind: "failing" };
  const branches = [...new Set(fails.map((o) => o.headBranch))].sort();
  const [branch] = branches;
  if (branch && branches.length === 1 && branch !== "main") return { kind: "branch-local", branch };
  return { kind: "suspect", branches };
}

const order: Verdict["kind"][] = ["flaky", "failing", "suspect", "branch-local", "stable"];
export function formatReport(tests: Map<string, Observation[]>, all: boolean, filter?: string) {
  const rows = [];
  for (const [id, observations] of tests) {
    if (filter !== undefined && !id.includes(filter)) continue;
    const v = verdict(observations);
    if (v.kind === "stable" && !all && filter === undefined) continue;
    const counts = new Map<string, { pass: number; fail: number }>();
    let pass = 0,
      fail = 0;
    for (const o of observations) {
      if (o.outcome === "skip") continue;
      const count = counts.get(o.workflow) ?? { pass: 0, fail: 0 };
      count[o.outcome]++;
      counts.set(o.workflow, count);
      if (o.outcome === "fail") fail++;
      else pass++;
    }
    if (!counts.size) continue;
    const detail =
      v.kind === "flaky"
        ? v.evidence
        : v.kind === "suspect"
          ? v.branches.join(", ")
          : v.kind === "branch-local"
            ? v.branch
            : "";
    const workflows = [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([w, c]) => `${w}: ${c.pass} pass, ${c.fail} fail`);
    const rate = fail / (pass + fail);
    rows.push({
      id,
      kind: v.kind,
      rate,
      text: `${v.kind}  ${fail}/${pass + fail} failed (${(rate * 100).toFixed(1)}%)  ${id}  [${workflows.join("; ")}] ${detail}`.trimEnd(),
    });
  }
  return rows
    .sort(
      (a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) ||
        b.rate - a.rate ||
        a.id.localeCompare(b.id),
    )
    .map((r) => r.text.replace(/\p{Cc}/gu, (c) => JSON.stringify(c).slice(1, -1)))
    .join("\n");
}

const gh = promisify(execFile);
const itemSchema = z.object({
  id: z.int().positive(),
  name: z.string(),
  expired: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  workflow_run: z.object({
    id: z.int().positive(),
    head_sha: z.string().min(1),
    head_branch: z.string().min(1),
  }),
});
function artifactFrom(item: unknown) {
  const header = z.object({ name: z.string(), expired: z.boolean() }).parse(item);
  const match = /^test-results-v1-(.+)-([1-9]\d*)$/u.exec(header.name);
  if (header.expired || !match?.[1]) return [];
  const a = itemSchema.parse(item);
  return [
    {
      id: a.id,
      name: a.name,
      created: a.created_at,
      run: {
        workflow: match[1],
        attempt: Number(match[2]),
        runId: a.workflow_run.id,
        headSha: a.workflow_run.head_sha,
        headBranch: a.workflow_run.head_branch,
      },
    },
  ];
}
type Artifact = ReturnType<typeof artifactFrom>[number];
export function selectArtifacts(items: unknown[], last: number, previous: Artifact[] = []) {
  const found = new Map(previous.map((a) => [a.id, a]));
  for (const a of items.flatMap(artifactFrom)) found.set(a.id, a);
  return [...found.values()]
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created) || b.id - a.id)
    .slice(0, last);
}
async function listArtifacts(last: number) {
  let selected: Artifact[] = [];
  for (let page = 1; ; page++) {
    const { stdout } = await gh("gh", [
      "api",
      `repos/{owner}/{repo}/actions/artifacts?per_page=100&page=${page}`,
    ]);
    const batch = z.object({ artifacts: z.array(z.unknown()) }).parse(JSON.parse(stdout)).artifacts;
    selected = selectArtifacts(batch, last, selected);
    if (selected.length === last || batch.length < 100) return selected;
  }
}
async function load(a: Artifact, cache: string) {
  const dir = join(cache, String(a.id));
  if (!(await stat(dir, { throwIfNoEntry: false }))) {
    const temp = await mkdtemp(dir + "-");
    try {
      await gh("gh", ["run", "download", String(a.run.runId), "--name", a.name, "--dir", temp]);
      try {
        await rename(temp, dir);
      } catch (error) {
        if (!(await stat(dir, { throwIfNoEntry: false }))) throw error;
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  return readArtifact(dir);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      last: { type: "string", default: "200" },
      test: { type: "string" },
      all: { type: "boolean", default: false },
    },
  });
  const last = z.coerce.number().int().positive().parse(values.last);
  const artifacts = await listArtifacts(last);
  const tests = new Map<string, Observation[]>();
  const cache = join(tmpdir(), "madori-test-history");
  await mkdir(cache, { recursive: true });
  let unreadable = 0;
  for (let i = 0; i < artifacts.length; i += 6) {
    const batch = artifacts.slice(i, i + 6);
    const loaded = await Promise.all(
      batch.map(async (a) => {
        try {
          return { run: a.run, records: await load(a, cache) };
        } catch (error) {
          console.error(`Unreadable artifact ${a.id} (${a.name}): ${String(error)}`);
          return undefined;
        }
      }),
    );
    for (const result of loaded) {
      if (!result) {
        unreadable++;
        continue;
      }
      for (const { suite, id, outcome } of result.records) {
        const key = `${suite}: ${id}`;
        const obs = tests.get(key) ?? [];
        obs.push({ ...result.run, outcome });
        tests.set(key, obs);
      }
    }
  }
  console.log(`${artifacts.length - unreadable} runs read, ${unreadable} unreadable artifacts.`);
  const report = formatReport(tests, values.all, values.test);
  if (report) console.log(report);
}
