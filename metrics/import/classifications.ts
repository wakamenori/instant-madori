import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { metricsHome } from "../home.ts";
import { publish } from "../hook/spool.ts";
import { classifications } from "../ingest/classification.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage: node metrics/import/classifications.ts FILE");
const rows = classifications.parse(JSON.parse(readFileSync(path, "utf8")));
publish(
  metricsHome(process.env),
  "classification-" + Date.now() + "-" + randomUUID() + ".json",
  rows,
);
