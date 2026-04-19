-- Row Level Security for Speakist.
--
-- Roles at play:
--   * anon                 — unauthenticated visitor
--   * authenticated        — any signed-in user
--   * service_role         — used only by the Next.js server via SUPABASE_SERVICE_ROLE_KEY
--   * (implicit) postgres  — migrations/admin
--
-- Design principles:
--   * Every table has RLS enabled. No "disabled" tables.
--   * Writes to money tables (credit_ledger, usage_events) are service_role
--     only — clients never mutate these directly. Our Next.js API routes are
--     the only writers.
--   * Super admins (profiles.is_super_admin = true) can read and update
--     org-scoped rows regardless of membership.
--   * Org-scoped reads use the is_org_member / is_org_admin helpers.

alter table public.profiles            enable row level security;
alter table public.organizations       enable row level security;
alter table public.org_members         enable row level security;
alter table public.invitations         enable row level security;
alter table public.vocabulary_entries  enable row level security;
alter table public.credit_ledger       enable row level security;
alter table public.usage_events        enable row level security;
alter table public.pricing_config      enable row level security;
alter table public.app_settings        enable row level security;
alter table public.device_auth_codes   enable row level security;
alter table public.mac_sessions        enable row level security;

-- ============================================================================
-- profiles
-- ============================================================================

create policy "profiles: read own or super-admin"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_super_admin(auth.uid()));

create policy "profiles: update own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- Users can NOT promote themselves to super-admin. is_super_admin is only
    -- mutable via service_role.
    and is_super_admin = (select is_super_admin from public.profiles where id = auth.uid())
  );

create policy "profiles: super-admin all"
  on public.profiles for all
  to authenticated
  using (public.is_super_admin(auth.uid()))
  with check (public.is_super_admin(auth.uid()));

-- ============================================================================
-- organizations
-- ============================================================================

create policy "orgs: members read"
  on public.organizations for select
  to authenticated
  using (public.is_org_member(auth.uid(), id) or public.is_super_admin(auth.uid()));

create policy "orgs: admins update"
  on public.organizations for update
  to authenticated
  using (public.is_org_admin(auth.uid(), id) or public.is_super_admin(auth.uid()))
  with check (public.is_org_admin(auth.uid(), id) or public.is_super_admin(auth.uid()));

-- Org creation and deletion go through server routes (service_role).
-- No insert/delete policy for authenticated → blocked.

-- ============================================================================
-- org_members
-- ============================================================================

create policy "org_members: members see membership"
  on public.org_members for select
  to authenticated
  using (public.is_org_member(auth.uid(), org_id) or public.is_super_admin(auth.uid()));

create policy "org_members: admins manage"
  on public.org_members for all
  to authenticated
  using (public.is_org_admin(auth.uid(), org_id) or public.is_super_admin(auth.uid()))
  with check (public.is_org_admin(auth.uid(), org_id) or public.is_super_admin(auth.uid()));

-- ============================================================================
-- invitations
-- ============================================================================
-- Admins of the org manage. Invitees look up their invitation by token via a
-- server route (service_role), so no anon policy is needed here.

create policy "invitations: admins manage"
  on public.invitations for all
  to authenticated
  using (public.is_org_admin(auth.uid(), org_id) or public.is_super_admin(auth.uid()))
  with check (public.is_org_admin(auth.uid(), org_id) or public.is_super_admin(auth.uid()));

-- ============================================================================
-- vocabulary_entries — per-user
-- ============================================================================

create policy "vocab: own rows"
  on public.vocabulary_entries for all
  to authenticated
  using (user_id = auth.uid() or public.is_super_admin(auth.uid()))
  with check (user_id = auth.uid());

-- ============================================================================
-- credit_ledger — read-only for members, writes are service_role
-- ============================================================================

create policy "credit_ledger: org members read"
  on public.credit_ledger for select
  to authenticated
  using (public.is_org_member(auth.uid(), org_id) or public.is_super_admin(auth.uid()));

-- No insert/update/delete policies → authenticated users cannot mutate.

-- ============================================================================
-- usage_events — user sees own rows, admins see org's, super-admin sees all
-- ============================================================================

create policy "usage_events: scoped read"
  on public.usage_events for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_org_admin(auth.uid(), org_id)
    or public.is_super_admin(auth.uid())
  );

-- ============================================================================
-- pricing_config — public read (pricing page), super-admin write
-- ============================================================================

create policy "pricing: public read"
  on public.pricing_config for select
  to anon, authenticated
  using (true);

create policy "pricing: super-admin write"
  on public.pricing_config for update
  to authenticated
  using (public.is_super_admin(auth.uid()))
  with check (public.is_super_admin(auth.uid()));

-- ============================================================================
-- app_settings — super-admin only (contains encrypted system Deepgram key)
-- ============================================================================

create policy "app_settings: super-admin only"
  on public.app_settings for all
  to authenticated
  using (public.is_super_admin(auth.uid()))
  with check (public.is_super_admin(auth.uid()));

-- ============================================================================
-- device_auth_codes — service_role only (opaque to clients)
-- ============================================================================
-- No policies defined → only service_role can access. Mac + web both go
-- through Next.js API routes.

-- ============================================================================
-- mac_sessions — users can see and revoke their own sessions
-- ============================================================================

create policy "mac_sessions: own read"
  on public.mac_sessions for select
  to authenticated
  using (user_id = auth.uid() or public.is_super_admin(auth.uid()));

create policy "mac_sessions: own revoke"
  on public.mac_sessions for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- grants on the view
-- ============================================================================

grant select on public.org_credit_balances to authenticated;
