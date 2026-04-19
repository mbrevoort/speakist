// Service-role Supabase client. Bypasses RLS — use ONLY in server routes
// where we've already authenticated the caller (via `createClient().auth`
// from ./server) and confirmed they're authorized for the action.
//
// Every money mutation (credit_ledger insert, usage_events insert, Stripe
// webhook handling) goes through this client because those tables have no
// write policies for the `authenticated` role.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL missing — admin client unavailable"
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
