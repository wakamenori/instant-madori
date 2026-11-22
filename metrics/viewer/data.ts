import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { poissonBounds } from "../build/poisson.ts";

const n = z.int().nonnegative();
const value = z.number().nullable();
const label = z.string();
const counts = {
  active_minutes: n,
  issue_minutes: n,
  feature_minutes: n,
  features: n,
  open_start: n,
  open_end: n,
};
function query<T extends z.ZodRawShape>(db: DatabaseSync, shape: T, sql: string) {
  const statement = db.prepare(sql);
  const schema = z.array(z.object(shape));
  return (...params: SQLInputValue[]) => schema.parse(statement.all(...params));
}
const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const flag = z.union([z.literal(0), z.literal(1)]);
const qualitySchema = {
  area: label,
  first_pass: flag.nullable(),
  observed: flag,
  rework: flag,
  escaped: flag,
  closed: n,
};
type QualityRow = z.infer<z.ZodObject<typeof qualitySchema>>;
function proportion(hits: number, n: number) {
  if (!n) return { value: null, low: null, high: null, n };
  const value = hits / n;
  const center = value + 1.9208 / n;
  const radius = 1.96 * Math.sqrt((value * (1 - value)) / n + 0.9604 / (n * n));
  const divisor = 1 + 3.8416 / n;
  return {
    value,
    low: Math.max(0, (center - radius) / divisor),
    high: Math.min(1, (center + radius) / divisor),
    n,
  };
}
function qualityRates(rows: QualityRow[], area: string) {
  const cohort = rows.filter((r) => r.area === area);
  const known = cohort.filter((r) => r.first_pass !== null);
  const observed = cohort.filter((r) => r.observed).length;
  return {
    area,
    total: cohort.length,

    observed,
    first_pass: proportion(known.filter((r) => r.first_pass).length, known.length),
    rework: proportion(cohort.filter((r) => r.rework).length, cohort.length),
    escaped: proportion(cohort.filter((r) => r.escaped).length, cohort.length),
  };
}
export function readViewerData(db: DatabaseSync, now = new Date()) {
  const hours = query(
    db,
    { hour: n, ...counts },
    "SELECT * FROM mart_kpi WHERE window='hour' AND active_minutes>0 ORDER BY hour",
  )();
  const clock = query(
    db,
    { minute: n, owners: n, feature_minutes: n, capacity: value },
    "SELECT minute,owners,feature_minutes,owners+slots capacity FROM owner_capacity_minute ORDER BY minute",
  )();
  const breaks = clock.flatMap((r, i) =>
    i > 0 && clock[i - 1]?.minute !== r.minute - 60 ? [{ position: i, resume: r.minute }] : [],
  );
  let position = 0;
  const operatingHours = hours.map((h) => ({ ...h, position: (position += h.active_minutes) }));
  const open = query(
    db,
    { count: n },
    "SELECT count(DISTINCT issue) count FROM owner_interval WHERE julianday(start)<julianday(?,'unixepoch') AND julianday(end)>julianday(?,'unixepoch')",
  );
  const quality = query(
    db,
    qualitySchema,
    "SELECT q.*,unixepoch(c.closed_at) closed FROM mart_quality_issue q JOIN issue_classification c USING(issue)",
  )();
  const features = query(
    db,
    { issue: n, title: label, closed: n },
    `SELECT c.issue,coalesce(f.title,'題名未取得') title,unixepoch(c.closed_at) closed
    FROM issue_classification c LEFT JOIN mart_issue_flow f USING(issue) WHERE c.pr IS NOT NULL AND c.ownership='owner' AND c.kind='機能'`,
  )();
  const issueStates = query(
    db,
    { issue: n, state: label, minutes: n },
    `SELECT m.issue,state,count(*) minutes FROM mart_minute m JOIN issue_classification c USING(issue) WHERE c.kind='機能' GROUP BY m.issue,state`,
  )();
  const featureIssues = features
    .map((f) => {
      const states = issueStates.filter((s) => s.issue === f.issue);
      return { ...f, states, minutes: states.reduce((sum, s) => sum + s.minutes, 0) };
    })
    .sort((a, b) => b.minutes - a.minutes || a.issue - b.issue);
  const states = query(
    db,
    { state: label, minutes: n },
    `SELECT state,count(*) minutes FROM mart_minute JOIN issue_classification USING(issue) WHERE kind='機能' AND minute>=? AND minute<? GROUP BY state`,
  );
  const slots = query(
    db,
    { reason: label, slots: n },
    "SELECT reason,sum(slots) slots FROM mart_empty_slot WHERE minute>=? AND minute<? GROUP BY reason",
  );
  // Whole UTC hours are already aggregated. Only the leading partial hour needs minute records.
  const kinds = query(
    db,
    { kind: label, minutes: n, completions: n },
    `WITH parts AS (
    SELECT kind,minutes,completions FROM mart_kind_period WHERE window='hour' AND hour>=? AND hour<?
    UNION ALL SELECT coalesce(kind,'unknown'),count(*),0 FROM mart_minute LEFT JOIN issue_classification USING(issue)
    WHERE minute>=? AND minute<? GROUP BY kind
    UNION ALL SELECT coalesce(kind,'unknown'),0,count(*) FROM issue_classification WHERE pr IS NOT NULL AND ownership='owner'
    AND unixepoch(closed_at)>=? AND unixepoch(closed_at)<? GROUP BY kind)
    SELECT kind,sum(minutes) minutes,sum(completions) completions FROM parts GROUP BY kind ORDER BY kind`,
  );
  const windows = [4, 8, 16, 24, 48].map((length) => {
    const points = operatingHours.map((h) => {
      const active = clock.slice(Math.max(0, h.position - length * 60), h.position);
      const first = active[0];
      if (!first) throw new Error("Missing operating minutes");
      const start = first.minute,
        end = h.hour + 3600;

      const whole = Math.ceil(start / 3600) * 3600;
      const byKind = kinds(whole, end, start, whole, start, whole);
      const count = byKind.find((r) => r.kind === "機能")?.completions ?? 0,
        bounds = poissonBounds(count);
      const minutes = active.length,
        issue = active.reduce((s, r) => s + r.owners, 0),
        feature = active.reduce((s, r) => s + r.feature_minutes, 0);
      const cohort = quality.filter((r) => r.closed >= start && r.closed < end);
      return {
        start,
        end,
        position: h.position,
        active_minutes: minutes,
        issue_minutes: issue,
        feature_minutes: feature,
        features: count,
        open_start: z.number().parse(open(start, start)[0]?.count),
        open_end: h.open_end,
        throughput: (count * 60) / minutes,
        throughput_low: (bounds.lower * 60) / minutes,
        throughput_high: (bounds.upper * 60) / minutes,
        parallelism: issue / minutes,
        feature_share: ratio(feature, issue),
        hours_per_feature: ratio(feature / 60, count),
        hours_per_feature_low: feature / 60 / bounds.upper,
        hours_per_feature_high: ratio(feature / 60, bounds.lower),
        capacity: active.every((r) => r.capacity !== null)
          ? active.reduce((sum, r) => sum + (r.capacity ?? 0), 0) / minutes
          : null,
        slots: slots(start, end),
        kinds: byKind,
        states: states(start, end),
        quality: ["product", "development"].map((area) => qualityRates(cohort, area)),
      };
    });
    const latest = points.at(-1);
    return {
      length,
      points,
      issues: latest
        ? featureIssues.filter((f) => f.closed >= latest.start && f.closed < latest.end)
        : [],
    };
  });
  const effects = query(
    db,
    {
      name: label,
      issues: label,
      minutes: n,
      before: value,
      before_low: value,
      before_high: value,
      before_n: n.nullable(),
      after: value,
      after_low: value,
      after_high: value,
      after_n: n.nullable(),
    },
    `SELECT t.name,(SELECT group_concat('#'||value, '・') FROM json_each(b.issues)) issues,b.minutes,
      b.rate before,b.low before_low,b.high before_high,b.total before_n,
      a.rate after,a.low after_low,a.high after_high,a.total after_n
      FROM improvement_observation b JOIN improvement_observation a USING(target,grp)
      JOIN improvement_target t ON t.id=b.target WHERE b.side='before' AND a.side='after'
      ORDER BY b.first_merge,t.name`,
  )();
  const prevention = query(
    db,
    { issue: n, name: label, catches: value, checked_runs: n, main_runs: n, main_failures: value },
    "SELECT t.name,p.* FROM mart_prevention p JOIN improvement_target t ON t.id=p.target",
  )();
  const health = query(
    db,
    {
      source: label,
      last_poll: z.iso.datetime({ offset: true }).nullable(),
      last_append: z.iso.datetime({ offset: true }).nullable(),
      quarantined: n,
      failed_cycles: n,
      skipped_cycles: n,
      held: n,
      lag_minutes: value,
    },
    "SELECT * FROM mart_health ORDER BY source",
  )().map((r) => {
    const cadence = r.source.startsWith("t3.") ? 60 : r.source === "github.actions.job" ? 120 : 300;
    const stopped =
      r.last_poll !== null && now.getTime() - Date.parse(r.last_poll) > cadence * 3 * 1000;
    return { ...r, stopped };
  });
  const gaps = query(
    db,
    { issue: n.nullable(), reason: label },
    "SELECT issue,reason FROM mart_record_gap ORDER BY reason,issue",
  )();
  const verification = query(
    db,
    { issue: n.nullable(), pr: n.nullable(), reason: label },
    "SELECT issue,pr,reason FROM mart_verification_gap ORDER BY issue",
  )();
  const inactive = query(
    db,
    { start: n, end: n, minutes: n },
    "SELECT * FROM mart_inactive_stretch ORDER BY start",
  )();
  return {
    generatedAt: now.toISOString(),
    operatingHours,
    breaks,
    windows,
    effects,
    prevention,
    health,
    gaps,
    verification,
    inactive,
  };
}
export type ViewerData = ReturnType<typeof readViewerData>;
export type Point = ViewerData["windows"][number]["points"][number];
