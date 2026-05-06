-- ============================================================================
-- CHOGI BLOCKED ATTEMPTS LOG
-- Stores IPs / user agents of blocked wallets when they try to connect.
--
-- Run once in Supabase SQL editor:
--   https://supabase.com/dashboard/project/cuqhqcmrgpdjlhyqztnc/sql
-- Idempotent — safe to re-run.
-- ============================================================================

create table if not exists chogi_blocked_attempts (
  id           uuid          primary key default gen_random_uuid(),
  wallet       text          not null,
  ip           text          not null,
  user_agent   text,
  referrer     text,
  fingerprint  text,
  reason       text,
  created_at   timestamptz   default now()
);

-- speed up "show me recent KILLA attempts"
create index if not exists chogi_blocked_attempts_wallet_idx
  on chogi_blocked_attempts (wallet, created_at desc);
create index if not exists chogi_blocked_attempts_ip_idx
  on chogi_blocked_attempts (ip);
create index if not exists chogi_blocked_attempts_fingerprint_idx
  on chogi_blocked_attempts (fingerprint);
create index if not exists chogi_blocked_attempts_created_idx
  on chogi_blocked_attempts (created_at desc);

-- ────────────────────────────────────────────────────────────────────────
-- IF YOU ALREADY RAN THE EARLIER VERSION OF THIS SCRIPT,
-- the create-table will skip but you need to add the new columns.
-- Run these once in addition to the create-table block:
-- ────────────────────────────────────────────────────────────────────────
alter table chogi_blocked_attempts add column if not exists fingerprint text;
alter table chogi_blocked_attempts add column if not exists reason text;

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────────────
alter table chogi_blocked_attempts enable row level security;

-- NO public read or write access. Only the service key can read/write.
-- (anon key gets nothing — this data is admin-only.)

-- ── CHECK YOUR DATA ────────────────────────────────────────────────────────
-- After deploying:
--   1. Wait for KILLA to connect (or any blocked wallet)
--   2. Run: select * from chogi_blocked_attempts order by created_at desc;
--   3. Copy the IP into /middleware.js BLOCKED_IPS array
--   4. Commit + push → that IP is permanently blocked from chogi.xyz
-- ============================================================================
