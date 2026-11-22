import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { json } from "node:stream/consumers";
import type { z } from "zod";

type StopDecision = { kind: "allow" } | { kind: "block"; reason: string };
type Session = { session_id: string; cwd: string };
type Handler = (input: unknown, session: Session, schema: typeof z) => StopDecision;
const allow = { kind: "allow" } as const;

function targetSchema(schema: typeof z) {
  return schema.object({
    pr: schema.int().positive(),
    head: schema
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .brand<"CommitSha">(),
    attempt: schema.int().positive(),
  });
}

function statePath({ cwd, session_id }: Session) {
  const path = execFileSync(
    "git",
    ["rev-parse", "--git-path", `agent-guard/verifier-${session_id}.json`],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return resolve(cwd, path.trimEnd());
}

const rememberTarget: Handler = (input, session, schema) => {
  const { prompt } = schema.object({ prompt: schema.string() }).parse(input);
  const match = /verdict\.ts --pr (\d+) --head ([0-9a-f]{40}) --attempt (\d+)\b/u.exec(prompt);
  if (!match) return allow;
  const target = targetSchema(schema).parse({
    pr: Number(match[1]),
    head: match[2],
    attempt: Number(match[3]),
  });
  const path = statePath(session);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(target));
  return allow;
};

const checkVerdict: Handler = (input, session, schema) => {
  if (
    schema.object({ stop_hook_active: schema.boolean().default(false) }).parse(input)
      .stop_hook_active
  )
    return allow;
  const { pr, head, attempt } = targetSchema(schema).parse(
    JSON.parse(readFileSync(statePath(session), "utf8")),
  );
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
  const pages = schema
    .array(
      schema.array(
        schema.object({
          context: schema.string(),
          description: schema.string().nullable(),
        }),
      ),
    )
    .parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        `repos/{owner}/{repo}/commits/${head}/statuses?per_page=100`,
      ]),
    );
  if (
    pages.some((page) =>
      page.some((s) => s.context === "verify" && s.description?.startsWith(`attempt ${attempt}:`)),
    )
  )
    return allow;
  const current = schema
    .object({ headRefOid: targetSchema(schema).shape.head })
    .parse(gh(["pr", "view", String(pr), "--json", "headRefOid"]));
  if (current.headRefOid !== head) return allow;
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
    const input: unknown = await json(process.stdin);
    const { z } = await import("zod");
    const session = z
      .object({ session_id: z.string().regex(/^[A-Za-z0-9_-]+$/u), cwd: z.string().min(1) })
      .parse(input);
    const decision = handler(input, session, z);
    if (decision.kind === "block")
      console.log(JSON.stringify({ decision: "block", reason: decision.reason }));
  } catch {
    // A hook or GitHub failure must leave the session free to end.
  }
}
