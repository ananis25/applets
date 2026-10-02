/** Publication against SQLite, with the D1 adapter's atomic batch behavior. */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Exit, Option } from "effect";
import { expect, test } from "vite-plus/test";
import { layer, Registry } from "./registry.ts";

/** The D1 driver calls prepare/bind/all and batch; unused D1 methods are omitted. */
function registryLayer(db: DatabaseSync) {
  const prepare = (query: string, args: SQLInputValue[] = []): D1PreparedStatement => {
    // SAFETY: the D1 driver uses only bind and all here; SQLite executes its generated SQL and values.
    return {
      bind: (...values: SQLInputValue[]) => prepare(query, values),
      all: async () => ({ success: true, results: db.prepare(query).all(...args) }),
    } as D1PreparedStatement;
  };

  // SAFETY: this layer uses prepare and batch only; the batch has D1's commit-or-rollback behavior.
  const binding = {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      db.exec("BEGIN");

      try {
        const result = [];

        for (const statement of statements) result.push(await statement.all());
        db.exec("COMMIT");

        return result;
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
  } as D1Database;

  return layer(binding);
}

/** The current schema, with a trigger that can refuse a bundle midway through publication. */
function database() {
  const db = new DatabaseSync(":memory:");
  const migrations = path.join(import.meta.dirname, "..", "migrations");
  db.exec(readFileSync(path.join(migrations, "0001_schema.sql"), "utf8"));
  db.exec(readFileSync(path.join(migrations, "0002_triggers_are_settings.sql"), "utf8"));

  return db;
}

const version = {
  server: "export default {};",
  files: { "main.ts": "export function fetch() {}" },
  exports: ["fetch"],
  installed: [],
  description: "hello",
};

const refuseBundle =
  "CREATE TRIGGER refuse_bundle BEFORE INSERT ON bundle_parts BEGIN SELECT RAISE(ABORT, 'refused bundle'); END";

test("a failed first publication leaves no applet or partial source", async () => {
  const db = database();

  try {
    db.exec(refuseBundle);

    const exit = await Effect.runPromise(
      Registry.use((registry) => registry.putVersion("hello", "owner@example.com", version)).pipe(
        Effect.exit,
        Effect.provide(registryLayer(db)),
        Effect.scoped,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM applets").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM file_contents").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

test("publication clears a draft atomically and a later failure preserves the live version and draft", async () => {
  const db = database();

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry;
        const first = yield* registry.putVersion("hello", "owner@example.com", version);
        yield* registry.putDraft(first.id, { "main.ts": "saved draft" });

        const second = yield* registry.putVersion("hello", "owner@example.com", {
          ...version,
          server: "second",
        });

        expect(second.id).toBe(first.id);
        expect(second.current_version).toBe(2);
        expect(Option.isNone(yield* registry.getDraft(first.id))).toBe(true);
        yield* registry.putDraft(first.id, { "main.ts": "keep this draft" });
        db.exec(refuseBundle);

        const failed = yield* registry
          .putVersion("hello", "owner@example.com", { ...version, server: "refused" })
          .pipe(Effect.exit);

        expect(Exit.isFailure(failed)).toBe(true);
        expect(Option.getOrThrow(yield* registry.getApplet("hello")).current_version).toBe(2);
        expect(Option.getOrThrow(yield* registry.getDraft(first.id)).files).toEqual({
          "main.ts": "keep this draft",
        });
      }).pipe(Effect.provide(registryLayer(db)), Effect.scoped),
    );
  } finally {
    db.close();
  }
});
