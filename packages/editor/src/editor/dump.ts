/** An applet's SQLite database as SQL text, built through the same query route the SQLite page runs. */
import { z } from "zod";
import type { Cell, SqlResult } from "@applets/api";

export type RunSql = (sql: string) => Promise<SqlResult>;

/** The schema objects an applet made. The `_cf_` and `sqlite_` tables belong to the runtime. */
const schemaQuery = (where: string) =>
  `SELECT name, sql FROM sqlite_master WHERE ${where} AND sql IS NOT NULL AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`;

export const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

const literal = (cell: Cell): string => {
  if (cell === null) return "NULL";

  if (cell instanceof Object) return `X'${cell.blob}'`;

  return Number.isFinite(cell) ? String(cell) : `'${String(cell).replaceAll("'", "''")}'`;
};

export type Table = { name: string; sql: string; rows: number };

/** The rows of a `name, sql` query over `sqlite_master`. */
const SchemaRows = z.array(z.tuple([z.string(), z.string()]));

const CountRows = z.array(z.tuple([z.number()]));

/** The applet's tables with their row counts, in two queries. */
export async function listTables(run: RunSql): Promise<Table[]> {
  const schema = SchemaRows.parse((await run(schemaQuery("type = 'table'"))).rows);

  if (schema.length === 0) return [];

  const counting = schema.map(([name]) => `SELECT COUNT(*) FROM ${quoteName(name)}`);
  const counts = CountRows.parse((await run(counting.join(" UNION ALL "))).rows);

  return schema.map(([name, sql], index) => ({ name, sql, rows: counts[index]?.[0] ?? 0 }));
}

/** Every table with its rows, then the indexes, views and triggers, as statements that rebuild the database. */
export async function dumpSql(run: RunSql): Promise<string> {
  const lines: string[] = [];

  for (const table of await listTables(run)) {
    const { rows } = await run(`SELECT * FROM ${quoteName(table.name)}`);
    lines.push(`${table.sql};`);

    for (const row of rows) {
      lines.push(`INSERT INTO ${quoteName(table.name)} VALUES (${row.map(literal).join(", ")});`);
    }
  }

  const rest = SchemaRows.parse((await run(schemaQuery("type != 'table'"))).rows);

  for (const [, sql] of rest) lines.push(`${sql};`);

  return `${lines.join("\n")}\n`;
}
