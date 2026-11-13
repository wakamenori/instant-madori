import type { z } from "zod";

/**
 * Storage reads rows as one JSON column built in SQL (`json_object(...)`) and validates it
 * here, so each table has exactly one row→domain mapping and no result is trusted by cast.
 */
export function parseJsonColumn<T>(value: unknown, schema: z.ZodType<T>, what: string): T {
  if (typeof value !== "string") throw new StorageCorruption(what);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StorageCorruption(what);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new StorageCorruption(what);
  return result.data;
}

/** Reads the JSON column `json` from every row of a query result. */
export function parseJsonRows<T>(
  rows: readonly unknown[],
  schema: z.ZodType<T>,
  what: string,
): T[] {
  return rows.map((row) =>
    parseJsonColumn(
      typeof row === "object" && row !== null && "json" in row ? row.json : undefined,
      schema,
      what,
    ),
  );
}

/** Stored data that no longer matches its schema: a bug or a missed migration, never user error. */
export class StorageCorruption extends Error {
  constructor(what: string) {
    super(`Stored ${what} does not match its schema`);
    this.name = "StorageCorruption";
  }
}
