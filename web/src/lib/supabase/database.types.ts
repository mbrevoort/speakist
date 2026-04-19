// Placeholder Database type. Regenerated from the live schema by running
// `pnpm db:types` (which shells out to `supabase gen types typescript --local`).
//
// Phase 1 keeps this minimal so TypeScript compiles before the real types
// are generated. Phase 3 replaces this with the full generated file.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
