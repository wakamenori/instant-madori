import { readEvents, type LogRow, type QueryLogs } from "./workers-logs.ts";

type Mark = "start" | "live" | "exit";
const containerMarks = new Map<string, Mark | "none">([
  ["container.started", "start"],
  ["container.idle_stopped", "none"],
  ["container.invalid_record", "none"],
]);
const marksByKind = {
  geometry: "live",
  limits: "live",
  exited: "exit",
  api: null,
  other: null,
} as const;
type Verdict =
  | { kind: "empty" | "quiet" }
  | { kind: "cold" | "settling"; exitAt: number }
  | { kind: "warm"; alive: number; lastLiveAt: number };
const minute = 60_000;

export function coldness(rows: readonly LogRow[], at: number): Verdict {
  if (!rows.length) return { kind: "empty" };
  const marks = readEvents(rows)
    .flatMap((e) => {
      const mark =
        e.kind === "container" ? (containerMarks.get(e.name) ?? "live") : marksByKind[e.kind];
      return mark && mark !== "none" ? [{ t: e.t, mark }] : [];
    })
    .sort((a, b) => a.t - b.t || Number(b.mark === "exit") - Number(a.mark === "exit"));
  const last = marks.at(-1);
  if (!last) return { kind: "quiet" };
  let alive = 0;
  let lastLiveAt = 0;
  for (const { mark, t } of marks) {
    if (mark === "exit") alive = Math.max(0, alive - 1);
    else {
      alive = mark === "start" ? alive + 1 : Math.max(alive, 1);
      lastLiveAt = t;
    }
  }
  if (alive) return { kind: "warm", alive, lastLiveAt };
  return { kind: at - last.t < 5 * minute ? "settling" : "cold", exitAt: last.t };
}

type ColdDeps = {
  query: QueryLogs;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  report: (verdict: Verdict) => void;
};
export async function waitCold({ query, now, sleep, report }: ColdDeps) {
  const deadline = now() + 60 * minute;
  let last: Verdict | undefined;
  let failures = 0;
  while (now() < deadline) {
    const at = now();
    let verdict: Verdict;
    try {
      verdict = coldness(await query({ from: at - 120 * minute, to: at }), at);
    } catch (error) {
      console.error(
        `Workers Logs poll failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      if (++failures >= 3)
        throw new Error("Three consecutive Workers Logs polls failed", { cause: error });
      await sleep(30_000);
      continue;
    }
    failures = 0;
    if (last?.kind !== verdict.kind) report(verdict);
    last = verdict;
    if (verdict.kind === "empty")
      throw new Error(
        "no Workers Logs rows in the last 2 h; check observability and the token's account",
      );
    if (verdict.kind === "cold" || verdict.kind === "quiet") return verdict;
    await sleep(30_000);
  }
  throw new Error(`Container did not go cold within 60 min; last verdict: ${JSON.stringify(last)}`);
}
