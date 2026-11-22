import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { readViewerData, type ViewerData } from "./data.ts";
import { metricsHome } from "../home.ts";
import { renderDashboard } from "./render.ts";

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const { root } = metricsHome(process.env);
  const db = new DatabaseSync(join(root, "metrics-derived.sqlite"), {
    readOnly: true,
    timeout: 5000,
  });
  let data: ViewerData;
  try {
    db.exec("BEGIN");
    data = readViewerData(db);
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
