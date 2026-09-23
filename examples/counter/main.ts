/** Counts requests in the applet's own SQLite, keeps the last path in kv, and logs each hit. With a schedule set, each tick counts too. */
import { kv, log, sql, type ScheduledEvent } from "@std";

const setup = "CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, path TEXT NOT NULL)";

function hit(path: string): number {
  sql.execute(setup);

  const inserted = sql.execute({ sql: "INSERT INTO hits (path) VALUES (?)", args: [path] });
  kv.set("last-path", path);
  log.info(`hit ${inserted.lastInsertRowid}`, { path });

  return inserted.lastInsertRowid;
}

export function fetch(request: Request): Response {
  const previous = kv.get<string>("last-path") ?? null;
  const hits = hit(new URL(request.url).pathname);

  return Response.json({ applet: "counter", hits, previous });
}

export function scheduled(event: ScheduledEvent): void {
  hit(`scheduled ${event.cron}`);
}
