import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";

const n = z.int().nonnegative();
const value = z.number().nullable();
const label = z.string();
const tiers = z.enum(["work", "wait", "unclassified"]);
type Tier = z.infer<typeof tiers>;
const emptyTiers = () => ({ work: 0, wait: 0, unclassified: 0 });
type Cells = Record<string, Record<Tier, number>>;
interface Effort {
  tiers: Record<Tier, number>;
  phases: Cells;
  waits: Record<string, number>;
  work: { generation: number; local: number; ci_deploy: number };
}
const kpiSchema = {
  completions: n,
  throughput: z.number(),
  throughput_low: z.number(),
  throughput_high: z.number(),
  parallelism: z.number(),
  target_share: value,
  hours_per_completion: value,
  hours_per_completion_low: value,
  hours_per_completion_high: value,
  active_minutes: n,
  issue_minutes: n,
  target_minutes: n,
  open_start: n,
  open_end: n,
  features: n,
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
export function qualityRates(rows: QualityRow[], area: string) {
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
export function readViewerData(db: DatabaseSync) {
  const snapshot =
    query(
      db,
      { at: label.nullable() },
      "SELECT max(at) at FROM (SELECT max(last_append) at FROM mart_health UNION ALL SELECT max(last_quarantine) FROM mart_health)",
    )()[0]?.at ?? null;

  const clock = query(
    db,
    { minute: n },
    "SELECT minute FROM owner_capacity_minute WHERE minute >= (SELECT since FROM kpi_policy) ORDER BY minute",
  )();
  const positions = new Map<number, number>();
  const breaks = clock.flatMap(({ minute }, i) => {
    positions.set(Math.floor(minute / 3600) * 3600, i + 1);
    return i > 0 && clock[i - 1]?.minute !== minute - 60 ? [{ position: i, resume: minute }] : [];
  });
  const quality = query(
    db,
    qualitySchema,
    "SELECT q.*,unixepoch(c.closed_at) closed FROM mart_quality_issue q JOIN issue_classification c USING(issue)",
  )();
  const rolling = query(
    db,
    { hour: n, start: n, end: n, ...kpiSchema },
    "SELECT * FROM mart_kpi WHERE window='rolling' AND target=? AND span=? ORDER BY hour",
  );
  const intervals = query(
    db,
    {
      phase: label,
      tier: tiers,
      wait_key: label.nullable(),
      duration: n,
      generation: z.number(),
      local: z.number(),
      ci_deploy: z.number(),
    },
    `
    WITH bounds(s,e) AS (VALUES (?,?)), clipped AS (
      SELECT e.*,round((unixepoch(min(e.end,b.e),'subsec')-unixepoch(max(e.start,b.s),'subsec'))*1000) overlap
      FROM bounds b JOIN mart_effort_interval e ON e.start < b.e AND e.end > b.s
      LEFT JOIN issue_classification c USING(issue) WHERE (?='全種類' OR c.kind='機能')
    ) SELECT coalesce(phase,'none') phase,tier,wait_target||'.'||wait_detail wait_key,
    sum(overlap) duration,sum(generation_ms*overlap/ms) generation,
    sum(local_ms*overlap/ms) local,sum((ci_ms+deploy_ms)*overlap/ms) ci_deploy
    FROM clipped GROUP BY coalesce(phase,'none'),tier,wait_key`,
  );
  const slotRows = query(
    db,
    { reason: z.enum(["no_ready_issue", "resource_limit", "awaiting_dispatch"]), minutes: n },
    "SELECT reason,sum(slots) minutes FROM mart_empty_slot WHERE minute>=? AND minute<? GROUP BY reason",
  );
  const capacity = query(
    db,
    { capacity: value },
    "SELECT CASE WHEN count(slots)=count(*) THEN avg(owners+slots) END capacity FROM owner_capacity_minute WHERE minute>=? AND minute<?",
  );
  const issues = query(
    db,
    { issue: n, kind: label, title: label, closed: n },
    `
    SELECT c.issue,coalesce(kind,'unknown') kind,coalesce(f.title,'題名未取得') title,unixepoch(c.closed_at) closed
    FROM issue_classification c LEFT JOIN mart_issue_flow f USING(issue) WHERE c.pr IS NOT NULL AND ownership='owner'
    AND closed>=? AND closed<? AND (?='全種類' OR kind='機能')`,
  );
  const cells = query(
    db,
    { phase: label, tier: tiers, ms: n },
    "SELECT coalesce(phase,'none') phase,tier,sum(ms) ms FROM mart_effort_interval WHERE issue=? GROUP BY 1,2",
  );
  const kinds = query(
    db,
    { kind: label, minutes: n, completions: n },
    "SELECT kind,sum(minutes) minutes,sum(completions) completions FROM mart_kind_period WHERE window='rolling' AND span=? AND hour=? GROUP BY kind ORDER BY minutes DESC,kind",
  );
  const combos = ([4, 8, 24] as const).flatMap((span) =>
    (["機能", "全種類"] as const).map((target) => {
      const points = rolling(target, span).flatMap(({ hour, start, end, ...kpi }) => {
        const position = positions.get(hour);
        if (position === undefined) return [];
        const effort: Effort = {
          tiers: emptyTiers(),
          phases: {},
          waits: {},
          work: { generation: 0, local: 0, ci_deploy: 0 },
        };
        for (const row of intervals(
          new Date(start * 1000).toISOString(),
          new Date(end * 1000).toISOString(),
          target,
        )) {
          effort.tiers[row.tier] += row.duration;
          (effort.phases[row.phase] ??= emptyTiers())[row.tier] += row.duration;
          if (row.wait_key)
            effort.waits[row.wait_key] = (effort.waits[row.wait_key] ?? 0) + row.duration;
          effort.work.generation += row.generation;
          effort.work.local += row.local;
          effort.work.ci_deploy += row.ci_deploy;
        }
        const slots = { no_ready_issue: 0, resource_limit: 0, awaiting_dispatch: 0 };
        for (const row of slotRows(start, end))
          slots[row.reason] = row.minutes / kpi.active_minutes;
        return [
          {
            hour,
            start,
            end,
            position,
            kpi,
            effort,
            slots,
            capacity: capacity(start, end)[0]?.capacity ?? null,
            unclassified_share: ratio(
              effort.tiers.unclassified,
              Object.values(effort.tiers).reduce((a, b) => a + b, 0),
            ),
          },
        ];
      });
      const latest = points.at(-1);
      const completed = latest
        ? issues(latest.start, latest.end, target)
            .map((issue) => {
              const phases: Cells = {};
              let effort_ms = 0;
              for (const row of cells(issue.issue)) {
                (phases[row.phase] ??= emptyTiers())[row.tier] = row.ms;
                effort_ms += row.ms;
              }
              return { ...issue, effort_ms, cells: phases };
            })
            .sort((a, b) => b.effort_ms - a.effort_ms || a.issue - b.issue)
        : [];
      return {
        span,
        target,
        points,
        issues: completed,
        kinds: latest ? kinds(span, latest.hour) : [],
      };
    }),
  );
  const tags = query(
    db,
    { tag: label, start: label, end: label },
    `SELECT tag,start,end FROM mart_effort_tag WHERE issue=?
    AND (tag LIKE 'tier:%' OR tag LIKE 'run:%' OR tag IN ('queue:ci','approval')) ORDER BY tag,start`,
  );
  const timelines: Record<number, { name: string; intervals: [number, number][]; ms: number }[]> =
    {};
  for (const { issue } of combos.find((c) => c.span === 24 && c.target === "全種類")?.issues ??
    []) {
    const rows = tags(issue).map((r) => ({
      tag: r.tag,
      start: Date.parse(r.start),
      end: Date.parse(r.end),
    }));
    const first = Math.min(...rows.map((r) => r.start)),
      last = Math.max(...rows.map((r) => r.end));
    // Gaps shorter than one pixel of a 1500px track cannot be seen, and keeping them makes the page megabytes larger.
    const join = (last - first) / 1500;
    const lanes = new Map<string, { intervals: [number, number][]; ms: number }>();
    for (const row of rows) {
      const lane = lanes.get(row.tag) ?? { intervals: [], ms: 0 };
      const previous = lane.intervals.at(-1);
      if (previous && row.start - previous[1] <= join) previous[1] = Math.max(previous[1], row.end);
      else lane.intervals.push([row.start, row.end]);
      lane.ms += row.end - row.start;
      lanes.set(row.tag, lane);
    }
    timelines[issue] = Array.from(lanes, ([name, lane]) => ({ name, ...lane }));
  }
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
      last_success: z.iso.datetime({ offset: true }).nullable(),
      first_poll: z.iso.datetime({ offset: true }).nullable(),
      last_append: z.iso.datetime({ offset: true }).nullable(),
      quarantined: n,
      recent_quarantined: n,
      last_quarantine: label.nullable(),
      failed_cycles: n,
      skipped_cycles: n,
      held: n,
      lag_minutes: value,
    },
    `WITH polls AS (
      SELECT s.key source,s.value->>'$.last_poll' at,
        coalesce(s.value->>'$.failed_cycles',0)+coalesce(s.value->>'$.skipped_cycles',0) missed
      FROM staging_record r,json_each(r.payload,'$.sources') s
      WHERE r.source='metrics.receiver' AND s.value->>'$.last_poll' IS NOT NULL
    ), arrivals AS (
      SELECT source,min(at) first_poll,max(at) FILTER(WHERE missed=0) last_success FROM polls GROUP BY source
    )
    SELECT h.*,a.first_poll,
      CASE WHEN h.last_poll IS NOT NULL THEN nullif(max(coalesce(a.last_success,''),coalesce(h.last_append,'')),'') END last_success
      FROM mart_health h LEFT JOIN arrivals a USING(source) ORDER BY source`,
  )().map((r) => {
    const cadence = r.source.startsWith("t3.") ? 60 : r.source === "github.actions.job" ? 120 : 300;
    const reference = r.last_success ?? r.first_poll ?? r.last_poll;
    const stopped =
      reference !== null &&
      snapshot !== null &&
      Date.parse(snapshot) - Date.parse(reference) > cadence * 1000;
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
    generatedAt: snapshot,
    quality,
    timelines,
    breaks,
    combos,
    effects,
    prevention,
    health,
    gaps,
    verification,
    inactive,
  };
}
export type ViewerData = ReturnType<typeof readViewerData>;
export type Combo = ViewerData["combos"][number];
export type Point = Combo["points"][number];
