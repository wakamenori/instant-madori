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
  db.exec("CREATE TEMP TABLE settings(window_minutes INTEGER)");
  db.prepare("INSERT INTO settings VALUES(?)").run(
    z.coerce
      .number()
      .int()
      .positive()
      .parse(process.env.INSTANT_MADORI_METRICS_WINDOW_MINUTES ?? 480),
  );
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
