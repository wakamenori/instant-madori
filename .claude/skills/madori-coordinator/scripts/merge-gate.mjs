import { execFileSync } from "node:child_process";
import { git, deployingFiles } from "./deploy-files.mjs";

/** @typedef {{sha: string, pr: number | null, committedAt: Date}} Commit */
/** @typedef {{id: number, sha: string, createdAt: Date, status: "active" | "success" | "failure" | "cancelled", url: string}} DeployRun */
/** @typedef {{tip: Commit, deploying: Commit, commits: Commit[]}} Window */
/** @typedef {{kind: "green", run: DeployRun} | {kind: "running", run: DeployRun | null} | {kind: "red", run: DeployRun, failedStep: string | null} | {kind: "unchecked", why: "cancelled" | "no run"}} MainState */
/** @typedef {{allowed: true, deploys: boolean, why: string} | {allowed: false, deploys: true, reasons: string[]}} Verdict */

const shaPattern = /^[0-9a-f]{40}$/;
const positiveId = (value) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const dispatch = "gh workflow run deploy-staging.yml --ref main";
class UsageError extends Error {}

function request([kind, ...args]) {
  const invalid = new UsageError(
    "usage: merge-gate.mjs check <PR> <head> [--fixes <run>] [--at <sha>] | status [--at <sha>]",
  );
  const options = { kind };
  if (kind === "check") {
    options.pr = args.shift();
    options.head = args.shift();
    if (!positiveId(options.pr) || !shaPattern.test(options.head)) throw invalid;
  } else if (kind !== "status") throw invalid;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "--at" && !options.at && shaPattern.test(value)) options.at = value;
    else if (flag === "--fixes" && kind === "check" && !options.fixes && positiveId(value))
      options.fixes = Number(value);
    else throw invalid;
  }
  return options;
}

function readWindow(base) {
  const commits = [];
  for (const sha of git("rev-list", "--first-parent", "-n", "50", base).trim().split("\n")) {
    const [parents, date, subject] = git("show", "-s", "--format=%P%x00%cI%x00%s", sha)
      .trimEnd()
      .split("\0");
    const pr = /^Merge pull request #(\d+)\b/.exec(subject);
    const commit = { sha, pr: pr ? Number(pr[1]) : null, committedAt: new Date(date) };
    commits.push(commit);
    if (!parents || deployingFiles(sha, [sha + "^1", sha], "merge-gate")) {
      return { tip: commits[0], deploying: commit, commits };
    }
  }
  throw new Error("no deploying commit in the last 50 first-parent commits");
}

function api(path) {
  return JSON.parse(
    execFileSync("gh", ["api", "repos/{owner}/{repo}/actions/" + path], {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 << 20,
    }),
  );
}

function readRuns(sha) {
  const { workflow_runs: runs } = api(
    `workflows/deploy-staging.yml/runs?head_sha=${sha}&per_page=100`,
  );
  if (!Array.isArray(runs)) throw new Error("invalid workflow_runs from gh");
  const mainRuns = [];
  for (const run of runs) {
    if (typeof run?.head_branch !== "string" || run.head_sha !== sha)
      throw new Error("invalid run head from gh");
    if (run.head_branch !== "main") continue;
    const { id, created_at, status, conclusion, html_url } = run;
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      typeof created_at !== "string" ||
      !Number.isFinite(Date.parse(created_at)) ||
      typeof html_url !== "string" ||
      !/^https?:\/\/\S+$/.test(html_url) ||
      typeof status !== "string" ||
      !status ||
      !(typeof conclusion === "string" || (status !== "completed" && conclusion === null))
    )
      throw new Error("invalid deploy run from gh");
    let outcome = "active";
    if (status === "completed") {
      if (conclusion === "success") outcome = "success";
      else if (["cancelled", "skipped"].includes(conclusion)) outcome = "cancelled";
      else outcome = "failure";
    }
    mainRuns.push({ id, sha, url: html_url, createdAt: new Date(created_at), status: outcome });
  }
  return mainRuns;
}

function failedStep(id) {
  const { jobs } = api(`runs/${id}/jobs`);
  if (!Array.isArray(jobs)) throw new Error("invalid jobs from gh");
  let first = null;
  for (const job of jobs) {
    if (!Array.isArray(job?.steps)) throw new Error("invalid job steps from gh");
    for (const step of job.steps) {
      if (
        typeof step?.name !== "string" ||
        !(step.conclusion === null || typeof step.conclusion === "string")
      )
        throw new Error("invalid step from gh");
      if (step.conclusion === "failure") first ??= step.name;
    }
  }
  return first;
}

/** @param {Window} window @param {Map<string, DeployRun[]>} runsBySha @param {Date} now @returns {MainState} */
function mainState(window, runsBySha, now) {
  let cancelled = false;
  for (const { sha } of window.commits) {
    const runs = runsBySha.get(sha);
    const [run] = runs
      .filter((r) => r.status !== "cancelled")
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    if (run?.status === "active") return { kind: "running", run };
    if (run?.status === "success") return { kind: "green", run };
    if (run?.status === "failure") return { kind: "red", run, failedStep: null };
    cancelled ||= runs.length > 0;
  }
  if (!runsBySha.get(window.deploying.sha).length && now - window.deploying.committedAt < 300_000)
    return { kind: "running", run: null };
  return { kind: "unchecked", why: cancelled ? "cancelled" : "no run" };
}

/** @returns {Verdict} */
function verdict({ deploys, state, fixes, tip }) {
  if (!deploys) return { allowed: true, deploys, why: "Only ignored paths changed." };
  if (state.kind === "green") return { allowed: true, deploys, why: "The staging check passed." };
  if (state.kind === "unchecked")
    return { allowed: false, deploys, reasons: [`Unless staging is occupied, run ${dispatch}.`] };
  const { run } = state;
  if (state.kind === "running")
    return {
      allowed: false,
      deploys,
      reasons: [run ? `Wait for run ${run.id} ${run.url}.` : "The push run has not appeared yet."],
    };
  if (fixes === run.id) return { allowed: true, deploys, why: `This PR fixes run ${fixes}.` };
  const reasons = [
    `Run ${run.id} ${run.url} failed at ${run.sha.slice(0, 7)} (${state.failedStep ?? "unknown step"}).`,
    `Only the PR fixing this failure may merge: use --fixes ${run.id} for a deploying fix. Merge a non-deploying fix as is, then run ${dispatch}.`,
  ];
  if (fixes !== undefined) reasons.push(`--fixes ${fixes} does not match failed run ${run.id}.`);
  if (tip.sha !== run.sha)
    reasons.push(`If a later commit fixes it, check the tip with ${dispatch}.`);
  return { allowed: false, deploys, reasons };
}

function main() {
  const { kind, pr, head, at, fixes } = request(process.argv.slice(2));
  git("fetch", "-q", "origin", "main", ...(pr ? [`pull/${pr}/head`] : []));
  const mainSha = git("rev-parse", "origin/main").trim();
  if (at) git("merge-base", "--is-ancestor", at, mainSha);
  const base = at ?? mainSha;
  if (head && git("merge-base", "--all", head, base).trim() === head)
    throw new Error(`${head} is already in main at ${base}`);
  const window = readWindow(base);
  const runs = new Map(window.commits.map(({ sha }) => [sha, readRuns(sha)]));
  const state = mainState(window, runs, new Date());
  if (state.kind === "red") state.failedStep = failedStep(state.run.id);
  const check = kind === "check";
  const deploys = !check || Boolean(deployingFiles(base, [`${base}...${head}`], "merge-gate"));
  const result = verdict({ deploys, state, fixes, tip: window.tip });
  if (check)
    console.log((result.allowed ? "merge" : "wait") + "\ndeploys: " + (deploys ? "yes" : "no"));
  const commit = state.run ? window.commits.find((c) => c.sha === state.run.sha) : window.deploying;
  const details = state.run
    ? `run ${state.run.id} ${state.run.url}`
    : (state.why ?? "awaiting push run");
  const step = state.kind === "red" ? ` step: ${state.failedStep ?? "unknown"}` : "";
  console.log(
    `main: ${state.kind} ${commit.sha.slice(0, 7)} #${commit.pr ?? "-"} ${details}${step}`,
  );
  if (check || !result.allowed) {
    for (const reason of result.allowed ? [result.why] : result.reasons)
      console.log("reason: " + reason);
  }
  return check && !result.allowed ? 3 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`merge-gate: ${error.message}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
