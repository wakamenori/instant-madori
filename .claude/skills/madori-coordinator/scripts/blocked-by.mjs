import { execFileSync } from "node:child_process";

class UsageError extends Error {}
const positive = /^[1-9][0-9]*$/;
const issuePath = (n) => `repos/{owner}/{repo}/issues/${n}`;

function request(argv) {
  const at = argv.indexOf("--reason");
  const numbers = at === -1 ? argv : argv.slice(0, at);
  const reason = at === -1 ? null : argv[at + 1];
  if (
    numbers.length < 2 ||
    numbers.some((n) => !positive.test(n)) ||
    new Set(numbers).size !== numbers.length ||
    (at !== -1 && (at !== argv.length - 2 || !reason?.trim() || /[\r\n]/.test(reason)))
  )
    throw new UsageError("usage: blocked-by.mjs <issue> <blocker>... [--reason '<line>']");
  const [issue, ...blockers] = numbers;
  return { issue, blockers, reason };
}

function api(args, input) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: "pipe", input });
}

function readIssue(number) {
  const path = issuePath(number);
  const raw = JSON.parse(api([path]));
  if (String(raw?.number) !== number || typeof raw.body !== "string")
    throw new Error(`invalid issue body for #${number}`);
  const output = api([
    "--paginate",
    path + "/dependencies/blocked_by?per_page=100",
    "--jq",
    ".[].number",
  ]).trim();
  const blockedBy = output ? output.split("\n") : [];
  if (blockedBy.some((n) => !positive.test(n))) throw new Error("invalid blocked-by response");
  return { number, body: raw.body, blockedBy };
}

function dependencySection({ number, body }) {
  const headers = [...body.matchAll(/^## 依存(?:\r?\n|$)/gm)];
  if (headers.length !== 1) throw new Error(`#${number} needs exactly one ## 依存 section`);
  const start = headers[0].index + headers[0][0].length;
  const rest = body.slice(start);
  const end = rest.search(/^## /m);
  const content = end === -1 ? rest : rest.slice(0, end);
  const eol = headers[0][0].endsWith("\r\n") ? "\r\n" : "\n";
  const listed = new Set();
  for (const line of content.split(/\r?\n/)) {
    const lead = /^(?:- )?(#\d+(?:[、・, ]+#\d+)*)/.exec(line);
    if (lead) for (const match of lead[1].matchAll(/#(\d+)/g)) listed.add(match[1]);
  }
  return {
    listed,
    withLine(line) {
      const suffix = rest.slice(content.length);
      const existing = (content.match(/[^\n]*\n|[^\n]+$/g) ?? [])
        .filter((l) => !/^(?:- )?なし。?$/.test(l.trim()))
        .join("")
        .replace(/(?:\r?\n[ \t]*)+$/, "");
      const prefix = body.slice(0, start);
      const heading = prefix.endsWith("\n") ? prefix : prefix + eol;
      const tail = suffix ? eol + eol : content.match(/(?:\r?\n)*$/)[0];
      return heading + (existing.trim() ? existing + eol : eol) + line + tail + suffix;
    },
  };
}

function main() {
  const { issue, blockers, reason } = request(process.argv.slice(2));
  const current = readIssue(issue);
  const section = dependencySection(current);
  const missing = blockers.filter((n) => !section.listed.has(n));
  if (missing.length && !reason)
    throw new Error("pass --reason to add the missing dependency line");
  const register = blockers.flatMap((n) => {
    const id = api([issuePath(n), "--jq", ".id"]).trim();
    if (!positive.test(id)) throw new Error(`invalid database id for #${n}`);
    return current.blockedBy.includes(n) ? [] : [{ n, id }];
  });
  const labels = missing.map((n) => "#" + n).join("、");
  const body = missing.length ? section.withLine(`- ${labels}。${reason}`) : null;
  for (const { n, id } of register) {
    api(["-X", "POST", issuePath(issue) + "/dependencies/blocked_by", "-F", "issue_id=" + id]);
    console.error(`registered #${n} as blocking #${issue} on GitHub`);
  }
  if (body !== null) {
    api(["-X", "PATCH", issuePath(issue), "--input", "-"], JSON.stringify({ body }));
    console.error(`added ${labels} to #${issue}'s 依存 section`);
  }
  const after = readIssue(issue);
  const { listed } = dependencySection(after);
  const problems = [];
  for (const n of blockers) {
    if (!after.blockedBy.includes(n))
      problems.push(`#${n} is not in GitHub's blocked-by of #${issue}`);
    if (!listed.has(n)) problems.push(`#${n} is not in #${issue}'s 依存 section`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`#${issue} blocked by ${blockers.map((n) => "#" + n).join(" ")}`);
}

try {
  main();
} catch (error) {
  console.error(`blocked-by: ${error.message}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
