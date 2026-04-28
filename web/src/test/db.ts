// Test DB harness.
//
// Spins up a fresh in-memory better-sqlite3 instance per test file (or per
// test, if you want isolation), applies every migration in
// `drizzle/migrations/*.sql` against it, and installs it as the global
// override read by `getDb()`.
//
// Why this shape:
//   * `better-sqlite3` runs synchronously and gives us "real" SQLite
//     semantics (FK cascades, unique indexes, etc.) — which is exactly
//     the behavior we want to assert on. No mocks, no fakes.
//   * Drizzle's `drizzle-orm/better-sqlite3` driver shares the schema
//     module with `drizzle-orm/d1`, so `lib/orgs.ts` and friends work
//     against either driver unchanged.
//   * Reusing the production migration files keeps tests honest — if a
//     migration breaks the schema, the tests fail before D1 ever runs it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";

const MIGRATIONS_DIR = join(process.cwd(), "drizzle/migrations");

export interface TestDbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  raw: Database.Database;
  /** Tear down the DB and clear the global override. */
  close: () => void;
}

/**
 * Build a fresh in-memory DB, run every migration against it, and pin
 * it as the global `getDb()` override for the duration of the test.
 *
 * Tests that need isolation should call this in a `beforeEach`; tests
 * that share fixtures across cases can call it once in `beforeAll`.
 */
export function setupTestDb(): TestDbHandle {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON"); // D1 has FKs on by default; mirror that.

  // Apply every .sql migration in order. Skip the meta journal.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    runMigration(raw, sql);
  }

  const db = drizzle(raw, { schema });
  globalThis.__SPEAKIST_TEST_DB__ = db;

  return {
    db,
    raw,
    close() {
      globalThis.__SPEAKIST_TEST_DB__ = undefined;
      raw.close();
    },
  };
}

/** Apply one .sql migration string against the raw DB. */
function runMigration(raw: Database.Database, sql: string): void {
  raw.exec(sql);
}
