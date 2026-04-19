-- Speakist initial schema.
--
-- Money: stored as BIGINT millicents (1/1000 of a cent). Pricing at ~$0.0000574
-- per word would round to zero per transcription in integer cents, so we keep
-- three extra decimals of precision without resorting to NUMERIC. $5 = 500,000.
--
-- RLS policies live in the companion migration (20260419000002_rls.sql). This
-- file is pure schema + helper functions.

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================================
-- profiles — extends auth.users with app-specific fields
-- ============================================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_email_idx on public.profiles (lower(email));

-- Auto-create profile row on auth.users insert. Keeps email in sync so RLS
-- helpers and admin views don't have to join to auth.users.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- organizations + membership + invitations
-- ============================================================================

create table public.organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,
  -- When true, usage is not debited from credit_ledger. Paired with an override
  -- key below so comped orgs can point at their own Deepgram project.
  is_comped boolean not null default false,
  -- Org-specific Deepgram key. Encrypted at the app layer (never written to
  -- the DB in plaintext). When set, short-lived tokens for this org's users
  -- are minted from this key instead of app_settings.system_deepgram_key.
  deepgram_key_override_encrypted text,
  -- e.g. "acme.com" — anyone signing up with this email domain is auto-joined
  -- to this org as a 'member'. Nullable.
  auto_join_domain text,
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organizations_auto_join_domain_idx on public.organizations (lower(auto_join_domain))
  where auto_join_domain is not null;

create type public.org_role as enum ('owner', 'admin', 'member');

create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_idx on public.org_members (user_id);

create table public.invitations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.org_role not null default 'member',
  -- Random opaque token emailed to the invitee; the invitation is accepted by
  -- visiting /invite/{token} and signing in/up.
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by uuid not null references auth.users(id),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index invitations_org_idx on public.invitations (org_id);
create index invitations_email_idx on public.invitations (lower(email)) where accepted_at is null;

-- ============================================================================
-- vocabulary — per-user corrections, synced from the Mac app
-- ============================================================================
-- Server is source of truth. Mac app pulls on launch and pushes on every
-- correction-save. `updated_at` on each row is the conflict-resolution marker
-- (last write wins per unique (user_id, from_text, to_text)).

create table public.vocabulary_entries (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_text text not null,
  to_text text not null,
  count integer not null default 1,
  is_proper_noun boolean not null default false,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,  -- soft delete so Mac can reconcile tombstones
  unique (user_id, from_text, to_text)
);

create index vocab_user_updated_idx on public.vocabulary_entries (user_id, updated_at desc);

-- ============================================================================
-- credits — ledger-based, never mutate past rows
-- ============================================================================
-- Balance = sum of delta_millicents for an org. Positive = top-up, negative =
-- spend. Every spend row must link to a usage_event row (or be an admin
-- adjustment with created_by + note). Stripe webhook events are deduped via
-- stripe_event_id (unique).

create table public.credit_ledger (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  delta_millicents bigint not null,
  reason text not null check (reason in (
    'signup_bonus',
    'stripe_topup',
    'stripe_auto_topup',
    'usage',
    'refund',
    'adjustment',
    'comp'
  )),
  stripe_event_id text unique,
  usage_event_id uuid,  -- FK added after usage_events table created
  created_by uuid references auth.users(id),
  note text,
  created_at timestamptz not null default now()
);

create index credit_ledger_org_idx on public.credit_ledger (org_id, created_at desc);

-- ============================================================================
-- usage_events — one row per transcription
-- ============================================================================

create table public.usage_events (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  -- UUID generated by the Mac app at transcription time; unique per org to
  -- dedupe in case the client retries reporting.
  transcription_client_id text not null,
  word_count integer not null check (word_count >= 0),
  audio_seconds numeric(10, 3),
  model text not null,
  -- What we billed the org (debited from credit_ledger).
  cost_millicents bigint not null default 0,
  -- What we paid Deepgram (for margin analysis in super admin).
  deepgram_cost_millicents bigint,
  created_at timestamptz not null default now(),
  unique (org_id, transcription_client_id)
);

create index usage_events_org_idx on public.usage_events (org_id, created_at desc);
create index usage_events_user_idx on public.usage_events (user_id, created_at desc);

-- Now that usage_events exists, add the FK from credit_ledger.usage_event_id.
alter table public.credit_ledger
  add constraint credit_ledger_usage_event_fkey
  foreign key (usage_event_id) references public.usage_events(id) on delete set null;

-- Convenience view: credit balance per org. Super admin + billing UIs read
-- this instead of summing ledger rows in every query.
create or replace view public.org_credit_balances as
  select
    o.id as org_id,
    o.name,
    o.is_comped,
    coalesce(sum(cl.delta_millicents), 0)::bigint as balance_millicents
  from public.organizations o
  left join public.credit_ledger cl on cl.org_id = o.id
  group by o.id, o.name, o.is_comped;

-- ============================================================================
-- pricing_config — singleton row editable by super admin
-- ============================================================================

create table public.pricing_config (
  id integer primary key default 1,
  -- Per-word retail price. Stored as numeric to preserve sub-millicent
  -- precision; multiplied by word_count and rounded to bigint millicents
  -- on each spend.
  price_per_word_millicents numeric(12, 4) not null default 5.74,
  -- Deepgram's rate, used for margin display only (retail billing uses
  -- price_per_word_millicents above).
  deepgram_per_minute_millicents numeric(12, 4) not null default 430.0,  -- $0.0043/min = 430 millicents/min
  signup_bonus_millicents bigint not null default 500000,                -- $5.00
  default_auto_topup_amount_millicents bigint not null default 2000000,  -- $20.00
  default_auto_topup_threshold_millicents bigint not null default 500000,-- $5.00
  updated_at timestamptz not null default now(),
  constraint pricing_config_singleton check (id = 1)
);

insert into public.pricing_config (id) values (1);

-- ============================================================================
-- app_settings — system-wide Deepgram key (encrypted) + other globals
-- ============================================================================

create table public.app_settings (
  id integer primary key default 1,
  system_deepgram_key_encrypted text,
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);

insert into public.app_settings (id) values (1);

-- ============================================================================
-- device auth — Mac sign-in flow (device code)
-- ============================================================================
-- Mac app requests a pair (user_code, device_code), shows user_code to the
-- user, and polls /api/auth/device/poll with device_code. When the user visits
-- /link, signs in, and enters the user_code, the row is stamped with their
-- user_id. The poll then trades device_code for a session.

create table public.device_auth_codes (
  id uuid primary key default uuid_generate_v4(),
  -- Short, human-typable (e.g. "7F3Q-X2K9").
  user_code text not null unique,
  -- Long opaque string the Mac polls with.
  device_code text not null unique,
  -- Null until the user approves in the browser.
  user_id uuid references auth.users(id),
  approved_at timestamptz,
  consumed_at timestamptz,  -- set when the Mac exchanges device_code for tokens
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  device_name text,
  created_at timestamptz not null default now()
);

create index device_auth_user_code_idx on public.device_auth_codes (user_code);
create index device_auth_device_code_idx on public.device_auth_codes (device_code);

-- Refresh tokens tied to a specific Mac install. We store a hash, not the
-- plaintext. Revocation = set revoked_at.
create table public.mac_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  refresh_token_hash text not null unique,
  device_name text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index mac_sessions_user_idx on public.mac_sessions (user_id) where revoked_at is null;

-- ============================================================================
-- helper functions used by RLS
-- ============================================================================

create or replace function public.is_super_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_super_admin from public.profiles where id = uid), false);
$$;

create or replace function public.is_org_member(uid uuid, oid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where user_id = uid and org_id = oid
  );
$$;

create or replace function public.is_org_admin(uid uuid, oid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where user_id = uid and org_id = oid and role in ('owner', 'admin')
  );
$$;

-- ============================================================================
-- updated_at auto-stamp
-- ============================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger touch_profiles before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger touch_orgs before update on public.organizations
  for each row execute function public.touch_updated_at();
create trigger touch_vocab before update on public.vocabulary_entries
  for each row execute function public.touch_updated_at();
create trigger touch_pricing before update on public.pricing_config
  for each row execute function public.touch_updated_at();
create trigger touch_app_settings before update on public.app_settings
  for each row execute function public.touch_updated_at();
