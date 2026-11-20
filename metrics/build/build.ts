import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { metricsHome } from "../home.ts";
import { waitMinutes } from "./wait.ts";

const home = metricsHome(process.env);
const db = new DatabaseSync(join(home.root, "metrics-derived.sqlite"), { timeout: 5000 });
try {
  const uri = pathToFileURL(home.database);
  uri.searchParams.set("mode", "ro");
  db.prepare("ATTACH ? AS raw").run(uri.href);
  db.exec("PRAGMA main.journal_mode=WAL; BEGIN");
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  for (const row of db
    .prepare(
      "SELECT type,name FROM main.sqlite_schema WHERE type IN ('view','table') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC",
    )
    .all()) {
    db.exec("DROP " + (row.type === "view" ? "VIEW " : "TABLE ") + quote(String(row.name)));
  }
  for (const layer of ["staging", "core", "marts"]) {
    const dir = join(import.meta.dirname, "../models", layer);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(join(dir, file), "utf8"));
  }
  const flows = db
    .prepare("SELECT issue,launch,merged FROM mart_issue_flow WHERE merged IS NOT NULL")
    .all();
  const spans = db.prepare(
    "SELECT actor,kind,start,end FROM span WHERE issue=? AND start IS NOT NULL",
  );
  const events = db.prepare(
    "SELECT kind,at,attributes->>'$.wake_kind' wake_kind,attributes->>'$.actor' actor FROM event WHERE issue=? AND at IS NOT NULL",
  );
  const span = z.object({
    actor: z.string(),
    kind: z.string(),
    start: z.string(),
    end: z.string().nullable(),
  });
  const event = z.object({
    kind: z.string(),
    at: z.string(),
    wake_kind: z.string().nullable(),
    actor: z.string().nullable(),
  });
  const insert = db.prepare("INSERT INTO mart_issue_wait VALUES(?,?,?,'1')");
  for (const row of flows) {
    const issue = Number(row.issue);
    const totals = waitMinutes(
      String(row.launch),
      String(row.merged),
      spans.all(issue).map((r) => span.parse(r)),
      events.all(issue).map((r) => event.parse(r)),
    );
    for (const [state, minutes] of totals) insert.run(issue, state, minutes);
  }
  db.exec("COMMIT");
} finally {
  db.close();
}
