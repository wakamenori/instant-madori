import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { z } from "zod";
import { metricsHome } from "../home.ts";
import { renderDashboard, type DashboardData } from "./render.ts";

const time = z.iso.datetime({ offset: true });
const maybeTime = time.nullable();
const count = z.int().nonnegative();
const minutes = z.number().nullable();
const version = { definition_version: z.string() };
const steps = z
  .string()
  .transform((value, ctx): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ name: z.string(), minutes })));

const marts = z.object({
  mart_issue_flow: z.array(
    z.object({
      ...version,
      issue: z.int(),
      pr: z.int().nullable(),
      title: z
        .string()
        .nullable()
        .transform((v) => v ?? "タイトル未取得"),
      ready_at: maybeTime,
      launch: time,
      pr_opened: maybeTime,
      first_report: maybeTime,
      merged: maybeTime,
      deployed: maybeTime,
      last_owner_activity: maybeTime,
      verifier_rounds: count,
      fails: count,
      check_jobs: count,
      coordinator_messages: count,
      owner_wakes: count,
    }),
  ),
  mart_issue_wait: z.array(
    z.object({ ...version, issue: z.int(), state: z.string(), minutes: z.number() }),
  ),
  mart_ci_job: z.array(
    z.object({
      ...version,
      job_id: z.int(),
      created_at: time,
      workflow: z.string(),
      queue_minutes: minutes,
      run_minutes: minutes,
      conclusion: z.string().nullable(),
      mode: z.string().nullable(),
      steps,
    }),
  ),
  mart_runner_hour: z.array(
    z.object({
      ...version,
      hour: time,
      check_minutes: z.number(),
      deploy_minutes: z.number(),
      utilization: z.number(),
    }),
  ),
  mart_merge_wait: z.array(
    z.object({
      ...version,
      pr: z.int(),
      last_pass: maybeTime,
      merged: time,
      minutes,
      reason: z.string(),
    }),
  ),
  mart_wip: z.array(z.object({ ...version, at: time, active_owners: count, queued_ready: count })),
  mart_health: z.array(
    z.object({
      ...version,
      source: z.string(),
      last_append: maybeTime,
      last_poll: maybeTime,
      lag_minutes: minutes,
      held: count,
      quarantined: count,
      failed_cycles: count,
    }),
  ),
});
const rowsSchema = marts.extend({
  generated_at: time,
  span: z.array(z.object({ issue: z.int(), kind: z.string(), start: time, end: maybeTime })),
});

function toDashboardData(rows: unknown): DashboardData {
  const data = rowsSchema.parse(rows);
  let first = Infinity;
  let last = -Infinity;
  function include(...times: (string | null)[]) {
    for (const value of times) {
      if (value === null) continue;
      const t = Date.parse(value);
      first = Math.min(first, t);
      last = Math.max(last, t);
    }
  }
  for (const f of data.mart_issue_flow)
    include(
      f.ready_at,
      f.launch,
      f.pr_opened,
      f.first_report,
      f.merged,
      f.deployed,
      f.last_owner_activity,
    );
  for (const j of data.mart_ci_job) include(j.created_at);
  for (const r of data.mart_runner_hour) include(r.hour);
  for (const m of data.mart_merge_wait) include(m.last_pass, m.merged);
  for (const w of data.mart_wip) include(w.at);
  for (const h of data.mart_health) include(h.last_append, h.last_poll);
  for (const s of data.span) include(s.start, s.end);
  return {
    ...data,
    range_start: Number.isFinite(first) ? new Date(first).toISOString() : null,
    range_end: Number.isFinite(last) ? new Date(last).toISOString() : null,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const { root } = metricsHome(process.env);
  const db = new DatabaseSync(join(root, "metrics-derived.sqlite"), {
    readOnly: true,
    timeout: 5000,
  });
  let data: DashboardData;
  try {
    db.exec("BEGIN");
    const rows = Object.fromEntries(
      Object.keys(marts.shape).map((table) => [table, db.prepare("SELECT * FROM " + table).all()]),
    );
    const span = db
      .prepare(
        "SELECT issue,kind,start,end FROM span WHERE issue IS NOT NULL AND start IS NOT NULL",
      )
      .all();
    data = toDashboardData({ ...rows, span, generated_at: new Date().toISOString() });
  } finally {
    db.close();
  }
  const out = values.out ?? join(root, "dashboard.html");
  const temp = out + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, renderDashboard(data), { flag: "wx", mode: 0o600 });
    renameSync(temp, out);
  } finally {
    rmSync(temp, { force: true });
  }
}
