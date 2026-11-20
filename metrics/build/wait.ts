export type WaitSpan = { actor: string; kind: string; start: string; end: string | null };
export type WaitEvent = {
  kind: string;
  at: string;
  wake_kind: string | null;
  actor: string | null;
};
const priority = [
  "verifier_run",
  "owner_turn",
  "implementer_run",
  "advisor_run",
  "ci_run",
  "ci_queue",
] as const;
const state = {
  verifier_run: "verifier",
  owner_turn: "owner_turn",
  implementer_run: "implementer",
  advisor_run: "advisor",
  ci_run: "ci_run",
  ci_queue: "ci_queue",
};
export function waitMinutes(launch: string, merge: string, spans: WaitSpan[], events: WaitEvent[]) {
  const totals = new Map<string, number>();
  const turns = spans
    .filter((s) => s.kind === "owner_turn" && s.end)
    .sort((a, b) => a.start.localeCompare(b.start));
  const gaps = turns.flatMap((turn, i) => {
    const prev = turns
      .slice(0, i)
      .reverse()
      .find((t) => t.actor === turn.actor);
    const wake = events.find(
      (e) => e.kind === "owner_wake" && e.at === turn.start && e.actor === turn.actor,
    );
    return prev?.end
      ? [{ start: prev.end, end: turn.start, state: "gap:" + (wake?.wake_kind ?? "unknown") }]
      : [];
  });
  const handoffs = events
    .filter((e) => ["report", "verdict", "coordinator_message"].includes(e.kind))
    .sort((a, b) => b.at.localeCompare(a.at) || b.kind.localeCompare(a.kind));
  const end = Date.parse(merge);
  for (let t = Date.parse(launch); t < end; t += 60_000) {
    const at = new Date(t).toISOString();
    const kind = priority.find((k) =>
      spans.some((s) => s.kind === k && s.start <= at && s.end && s.end > at),
    );
    const last = handoffs.find((e) => e.at <= at);
    const wait = kind
      ? state[kind]
      : last?.kind === "report"
        ? "coord_dispatch"
        : last?.kind === "verdict"
          ? "coord_decide"
          : (gaps.find((g) => g.start <= at && g.end > at)?.state ?? "other");
    totals.set(wait, (totals.get(wait) ?? 0) + 1);
  }
  return totals;
}
