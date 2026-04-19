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

import { drizzle } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "./schema";

export function getDb() {
  const { env } = getCloudflareContext();
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;
export * from "./schema";
