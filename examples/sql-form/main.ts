/** SQL: a contact form whose submissions land in the applet's own SQLite, listed back on the same page. */
import { page, sql } from "@std";
import { Hono } from "npm:hono@4";

import type { NewSubmission, Submission } from "./shared/types.ts";

const setup = `CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`;

const list = (): ReadonlyArray<Submission> => {
  sql.execute(setup);

  return sql.execute<Submission>(
    "SELECT id, name, email, message, created_at FROM submissions ORDER BY id DESC",
  ).rows;
};

const add = (submission: NewSubmission): void => {
  sql.execute(setup);
  sql.execute({
    sql: "INSERT INTO submissions (name, email, message) VALUES (?, ?, ?)",
    args: [submission.name, submission.email, submission.message],
  });
};

const app = new Hono();

app.get("/api/submissions", (c) => c.json(list()));

app.post("/api/submissions", async (c) => {
  const body = await c.req.json<NewSubmission>();
  const name = body.name.trim();
  const email = body.email.trim();
  const message = body.message.trim();

  if (!name || !email || !message) return c.text("Name, email and message are all required.", 400);

  add({ name, email, message });

  return c.json(list());
});

app.get("*", () => page({ title: "Contact form" }));

export const fetch = app.fetch;
