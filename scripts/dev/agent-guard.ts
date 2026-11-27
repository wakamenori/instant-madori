import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { json } from "node:stream/consumers";

type StopDecision = { kind: "allow" } | { kind: "block"; reason: string };
type Session = { session_id: string; cwd: string };
type CommitSha = string & { readonly __brand: "CommitSha" };
type Handler = (input: Record<string, unknown>, session: Session) => StopDecision;
const allow = { kind: "allow" } as const;

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function commitSha(value: unknown): CommitSha {
  assert.ok(typeof value === "string" && /^[0-9a-f]{40}$/u.test(value));
  return value as CommitSha;
}

function positiveInteger(value: unknown) {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}

function parseTarget(value: unknown) {
  const { pr, head, attempt } = object(value);
  return { pr: positiveInteger(pr), head: commitSha(head), attempt: positiveInteger(attempt) };
}

function statePath({ cwd, session_id }: Session) {
  const path = execFileSync(
    "git",
    ["rev-parse", "--git-path", `agent-guard/session-${session_id}.json`],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return resolve(cwd, path.trimEnd());
}

function readState(path: string) {
  if (!existsSync(path)) return undefined;
  const { verifier } = object(JSON.parse(readFileSync(path, "utf8")));
  return { verifier: verifier === null ? null : parseTarget(verifier) };
}

const rememberTarget: Handler = ({ prompt }, session) => {
  assert.ok(typeof prompt === "string");
  const path = statePath(session);
  const state = readState(path);
  if (state?.verifier === null) return allow;
  const match = /verdict\.ts --pr (\d+) --head ([0-9a-f]{40}) --attempt (\d+)\b/u.exec(prompt);
  if (!match && state) return allow;
  const verifier = match
    ? parseTarget({
        pr: Number(match[1]),
        head: match[2],
        attempt: Number(match[3]),
      })
    : null;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ verifier }));
  return allow;
};

function parseStatuses(value: unknown) {
  assert.ok(Array.isArray(value));
  return value.flatMap((page: unknown) => {
    assert.ok(Array.isArray(page));
    return page.map((status: unknown) => {
      const { context, description } = object(status);
      assert.ok(
        typeof context === "string" && (description === null || typeof description === "string"),
      );
      return { context, description };
    });
  });
}

const checkVerdict: Handler = ({ stop_hook_active = false }, session) => {
  assert.ok(typeof stop_hook_active === "boolean");
  if (stop_hook_active) return allow;
  const verifier = readState(statePath(session))?.verifier;
  if (!verifier) return allow;
  const { pr, head, attempt } = verifier;
  function gh(args: string[]): unknown {
    return JSON.parse(
      execFileSync("gh", args, {
        cwd: session.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GH_REPO: "wakamenori/instant-madori" },
        timeout: 8000,
      }),
    );
  }
  const statuses = parseStatuses(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/{owner}/{repo}/commits/${head}/statuses?per_page=100`,
    ]),
  );
  if (
    statuses.some((s) => s.context === "verify" && s.description?.startsWith(`attempt ${attempt}:`))
  )
    return allow;
  const current = object(gh(["pr", "view", String(pr), "--json", "headRefOid"]));
  if (commitSha(current.headRefOid) !== head) return allow;
  return {
    kind: "block",
    reason: `You are the verifier for PR #${pr}. The head ${head} has no verify status for attempt ${attempt}. Before ending, run the verdict command from the brief with --pr ${pr} --head ${head} --attempt ${attempt}, either --pass or one or more --fail <check> arguments, and --report <file>. If the command fails, put its failure reason at the top of your final report.`,
  };
};

const handlers = new Map<string, Handler>([
  ["UserPromptSubmit", rememberTarget],
  ["Stop", checkVerdict],
]);
const handler = handlers.get(process.argv[2] ?? "");
if (!handler) {
  process.stdin.resume();
} else {
  try {
    const input = object(await json(process.stdin));
    const { session_id, cwd } = input;
    assert.ok(typeof session_id === "string" && /^[A-Za-z0-9_-]+$/u.test(session_id));
    assert.ok(typeof cwd === "string" && cwd.length > 0);
    const decision = handler(input, { session_id, cwd });
    if (decision.kind === "block")
      console.log(JSON.stringify({ decision: "block", reason: decision.reason }));
  } catch {
    // A hook or GitHub failure must leave the session free to end.
  }
}
