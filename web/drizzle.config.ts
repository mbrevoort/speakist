import { defineConfig } from "drizzle-kit";

// Drizzle is used only for schema → SQL migration generation and the studio.
// Migrations are applied via `wrangler d1 migrations apply <db> [--local]`
// — not by drizzle-kit itself — so we don't configure `dbCredentials` here.

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
});
