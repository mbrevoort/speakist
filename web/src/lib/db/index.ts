// Drizzle D1 client factory.
//
// Usage:
//     const db = getDb();
//     await db.select().from(users).where(...)
//
// The D1 binding is only available inside a Cloudflare request context —
// either via `getCloudflareContext()` in server components / route handlers,
// or via the OpenNext dev shim in `next dev`. Importing `db` at module load
// would fail at build time, so `getDb()` is a factory, not a singleton.
//
// IMPORTANT: Do NOT call `getDb()` from client components. The D1 binding
// doesn't exist there. Client components should call server actions or
// route handlers that use `getDb()` themselves.
//
// Test override: `globalThis.__SPEAKIST_TEST_DB__` — when set (only in
// vitest), `getDb()` returns it instead of touching the Cloudflare context.
// The test override is a `drizzle-orm/better-sqlite3` instance, which
// shares the BaseSQLiteDatabase query API with the D1 driver. We cast the
// return type because the structural type would force every caller to
// handle a union; in practice the query surface is identical.

import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __SPEAKIST_TEST_DB__: unknown;
}

export function getDb(): DrizzleD1Database<typeof schema> {
  if (globalThis.__SPEAKIST_TEST_DB__) {
    return globalThis.__SPEAKIST_TEST_DB__ as DrizzleD1Database<typeof schema>;
  }
  const { env } = getCloudflareContext();
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;
export * from "./schema";
