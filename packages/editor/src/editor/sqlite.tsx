import { useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@applets/ui/components/ui/table";
import { Textarea } from "@applets/ui/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cell, SqlResult } from "@applets/api";
import { call } from "../client.ts";
import { Failure } from "../failure.tsx";
import { download } from "./download.ts";
import { dumpSql, listTables, quoteName } from "./dump.ts";

const shownRows = 500;

const show = (cell: Cell): string => {
  if (cell === null) return "NULL";

  return cell instanceof Object ? `x'${cell.blob}'` : String(cell);
};

function Results({ result }: { result: SqlResult }) {
  const summary = `${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"} · ${result.rowsWritten} written`;

  return (
    <>
      <div className="px-3 py-1 text-xs text-muted-foreground">
        {summary}
        {result.rows.length > shownRows && ` · showing the first ${shownRows}`}
      </div>
      <Table className="w-max min-w-full font-mono text-xs">
        <TableHeader>
          <TableRow>
            {result.columns.map((column, index) => (
              <TableHead key={index}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.slice(0, shownRows).map((row, index) => (
            <TableRow key={index}>
              {row.map((cell, column) => (
                <TableCell
                  key={column}
                  className={`max-w-96 truncate ${cell === null ? "text-muted-foreground" : ""}`}
                  title={show(cell)}
                >
                  {show(cell)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

/** The applet's own SQLite database: its tables, a query runner, and a dump as SQL. Statements run in the live applet. */
export function Sqlite({ name }: { name: string }) {
  const client = useQueryClient();
  const [query, setQuery] = useState("");

  const run = (sql: string) =>
    call((api) => api.storage.sql({ params: { name }, payload: { sql } }));

  const tables = useQuery({ queryKey: ["applet", name, "tables"], queryFn: () => listTables(run) });

  const statement = useMutation({
    mutationFn: run,
    onSuccess: (data) => {
      if (data.rowsWritten > 0)
        void client.invalidateQueries({ queryKey: ["applet", name, "tables"] });
    },
  });

  const dump = useMutation({
    mutationFn: () => dumpSql(run),
    onSuccess: (text) => download(`${name}.sql`, text, "application/sql"),
  });

  const execute = (sql: string) => {
    setQuery(sql);
    statement.mutate(sql);
  };

  const error = statement.error ?? tables.error ?? dump.error;
  const result: SqlResult | undefined = statement.data;

  return (
    <section className="flex min-w-0 flex-1 bg-card">
      <div className="flex w-52 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide">
          Tables
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {tables.data?.length === 0 && (
            <div className="px-3 py-1 text-xs text-muted-foreground">None.</div>
          )}
          {tables.data?.map((table) => (
            <Button
              key={table.name}
              variant="ghost"
              size="xs"
              className="w-full justify-between rounded-none px-3 font-mono"
              title={table.sql}
              onClick={() => execute(`SELECT * FROM ${quoteName(table.name)} LIMIT 100`)}
            >
              <span className="truncate">{table.name}</span>
              <span className="text-muted-foreground">{table.rows}</span>
            </Button>
          ))}
        </div>
        <Button variant="outline" size="xs" className="m-2" onClick={() => dump.mutate()}>
          Dump as SQL
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-2 border-b border-border p-2">
          <Textarea
            aria-label="SQL"
            className="min-h-20 flex-1 font-mono text-xs"
            placeholder="SELECT * FROM …   (⌘Enter runs it)"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) execute(query);
            }}
          />
          <Button size="sm" disabled={query.trim() === ""} onClick={() => execute(query)}>
            Run
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <Failure className="m-3 w-auto" title="The query failed" error={error} />
          {!error && result && <Results result={result} />}
        </div>
      </div>
    </section>
  );
}
