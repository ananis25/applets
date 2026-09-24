/** A single-page app: a Hono API on the server, and a Preact page with UnoCSS utility classes in the browser. */
import { page } from "@std";
import { Hono } from "npm:hono@4";

const app = new Hono();

app.get("/api/greeting", (c) => c.json({ greeting: `Hello from the server at ${new Date().toISOString()}` }));

app.get("*", () => page({ title: "Preact app" }));

export const fetch = app.fetch;
