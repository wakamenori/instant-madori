import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { metricsHome } from "../home.ts";
import { poissonBounds } from "./poisson.ts";

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
  db.exec("CREATE TEMP TABLE backfill_kind(issue INTEGER PRIMARY KEY,kind TEXT NOT NULL)");
  const file = process.env.INSTANT_MADORI_METRICS_KIND_FILE;
  if (file) {
    const rows = z
      .array(
        z.object({
          issue: z.int().positive(),
          kind: z.enum([
            "機能",
            "不具合",
            "作りの見直し",
            "外部への追従",
            "開発の改善",
            "確かめと判断",
          ]),
        }),
      )
      .parse(JSON.parse(readFileSync(file, "utf8")));
    const put = db.prepare("INSERT INTO backfill_kind VALUES(?,?)");
    for (const row of rows) put.run(row.issue, row.kind);
  }
  db.exec("CREATE TEMP TABLE settings(window_minutes INTEGER)");
  db.prepare("INSERT INTO settings VALUES(?)").run(
    z.coerce
      .number()
      .int()
      .positive()
      .parse(process.env.INSTANT_MADORI_METRICS_WINDOW_MINUTES ?? 480),
  );
  // A locally available main history proves ancestry when a later deploy includes this merge.
  db.exec("CREATE TEMP TABLE main_commit(sha TEXT PRIMARY KEY,position INTEGER NOT NULL)");
  const history = spawnSync(
    "git",
    ["rev-list", "--first-parent", "--reverse", "refs/remotes/origin/main"],
    { cwd: import.meta.dirname, encoding: "utf8" },
  );
  if (history.status === 0) {
    const add = db.prepare("INSERT INTO main_commit VALUES(?,?)");
    for (const [index, sha] of history.stdout.trim().split("\n").entries()) add.run(sha, index);
  }
  const bounds = new Map<number, ReturnType<typeof poissonBounds>>();
  for (const side of ["lower", "upper"] as const) {
    db.function("poisson_" + side, { deterministic: true }, (value) => {
      const count = Number(value);
      const interval = bounds.get(count) ?? poissonBounds(count);
      bounds.set(count, interval);
      return interval[side];
    });
  }
  for (const layer of ["staging", "core", "marts"]) {
    const dir = join(import.meta.dirname, "../models", layer);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(join(dir, file), "utf8"));
  }
  db.exec("COMMIT");
} finally {
  db.close();
}
