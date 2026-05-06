-- ============================================================================
-- CHOGI SUBJECT PINS
-- Run this once in your Supabase SQL editor:
--   https://supabase.com/dashboard/project/cuqhqcmrgpdjlhyqztnc/sql
-- It is idempotent — safe to re-run.
-- ============================================================================

-- main table: one pin per wallet, latest overrides
create table if not exists chogi_subject_pins (
  id           uuid          primary key default gen_random_uuid(),
  wallet       text          not null,
  subject_id   text          not null,            -- "0042"
  threat       text,                              -- "ALPHA" | "BETA" | "GAMMA" | "DELTA" | "OMEGA"
  biosign      text,                              -- "STABLE" | "ELEVATED" | "CRITICAL" | "UNHINGED" | "CLASSIFIED"
  cell         text,                              -- "R-39"
  lat          numeric(7,4)  not null,            -- ~11m precision (4 decimals)
  lng          numeric(8,4)  not null,
  note         text,                              -- optional, capped 60 chars in handler
  created_at   timestamptz   default now()
);

-- one pin per wallet (lowercase enforced) — INSERT ... ON CONFLICT updates
create unique index if not exists chogi_subject_pins_wallet_uq
  on chogi_subject_pins (lower(wallet));

-- speed up "list all pins"
create index if not exists chogi_subject_pins_created_idx
  on chogi_subject_pins (created_at desc);

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────────────
alter table chogi_subject_pins enable row level security;

-- anyone (anon key) can SELECT
drop policy if exists "anyone can read pins" on chogi_subject_pins;
create policy "anyone can read pins"
  on chogi_subject_pins for select
  using (true);

-- only the service role (used by /api/pin) can INSERT/UPDATE
-- (no public INSERT policy = anon key cannot write directly)

-- ── REALTIME ───────────────────────────────────────────────────────────────
-- enable realtime broadcasts on this table
alter publication supabase_realtime add table chogi_subject_pins;

-- ============================================================================
-- DONE. Test it:
-- select count(*) from chogi_subject_pins;
-- ============================================================================
