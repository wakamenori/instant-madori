import { z } from "zod";
import { parseJsonColumn, StorageCorruption } from "./rows.ts";

export interface SqlPart {
  sql: string;
  bindings: unknown[];
}

const decodeRows = Symbol("decodeRows");

interface Statement<T> extends SqlPart {
  [decodeRows](rows: unknown[]): T;
}

export function write(part: SqlPart): Statement<void> {
  return { ...part, [decodeRows]: () => undefined };
}

export function rows<S extends z.ZodType>(
  part: SqlPart,
  schema: S,
  what: string,
): Statement<z.output<S>[]> {
  return {
    ...part,
    [decodeRows]: (values) => {
      const result = z.array(schema).safeParse(values);
      if (!result.success) throw new StorageCorruption(what);
      return result.data;
    },
  };
}

export function jsonRows<S extends z.ZodType>(
  part: SqlPart,
  schema: S,
  what: string,
): Statement<z.output<S>[]> {
  return rows(
    part,
    z.object({ json: z.unknown() }).transform(({ json }) => parseJsonColumn(json, schema, what)),
    what,
  );
}

export const foundSchema = z.object({ found: z.literal(1) });

export function d1(database: D1Database) {
  function prepare(part: SqlPart) {
    return database.prepare(part.sql).bind(...part.bindings);
  }
  return {
    async first<T>(statement: Statement<T[]>): Promise<T | null> {
      const value = await prepare(statement).first();
      return statement[decodeRows](value === null ? [] : [value])[0] ?? null;
    },
    async all<T>(statement: Statement<T[]>): Promise<T[]> {
      const result = await prepare(statement).all();
      return statement[decodeRows](result.results);
    },
    async batch<const S extends readonly Statement<unknown>[]>(
      statements: S,
    ): Promise<{
      [K in keyof S]: S[K] extends Statement<infer T> ? T : never;
    }> {
      const results = await database.batch(statements.map(prepare));
      if (results.length !== statements.length)
        throw new Error("D1 batch returned fewer results than statements");
      return statements.map((statement, index) =>
        statement[decodeRows](results[index]?.results ?? []),
      ) as {
        [K in keyof S]: S[K] extends Statement<infer T> ? T : never;
      };
    },
  };
}

export type D1 = ReturnType<typeof d1>;
