// Vitest global setup. Empty by design — per-test-file DB initialization
// happens in `setupTestDb()` from ./db.ts. Keeping this file around so we
// have a place to wire up future global hooks (e.g. mocking next-auth
// `auth()` once we test server actions that hit it).

import { vi } from "vitest";

// Many of our modules grab `crypto.randomUUID` at top level — that already
// exists in Node 20+. Nothing extra needed here for now.
void vi;
