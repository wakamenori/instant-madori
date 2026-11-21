import { z } from "zod";
import { hash } from "../l1/envelope.ts";
import type { Parsed } from "../l1/sources.ts";
import { candidate } from "./polled.ts";

export const classifications = z
  .array(
    z.strictObject({
      issue: z.int().positive(),
      kind: z.enum([
        "機能",
        "製品の不具合",
        "製品の作りの見直し",
        "開発の仕組みの改善",
        "開発の仕組みの不具合",
        "開発の仕組みの作りの見直し",
        "外の変化への追従",
        "確かめと判断",
      ]),
    }),
  )
  .refine((rows) => new Set(rows.map((row) => row.issue)).size === rows.length);

export function parseClassifications(bytes: Buffer): Parsed {
  try {
    const rows = classifications.parse(JSON.parse(bytes.toString()));
    return {
      records: rows.map((row) => candidate("classification.backfill", row.issue, null, row)),
      rejects: [],
      drops: [],
    };
  } catch {
    return {
      records: [],
      drops: [],
      rejects: [
        {
          source: "classification.backfill",
          reason: "invalid_classification",
          unitHash: hash(bytes),
          content: null,
        },
      ],
    };
  }
}
