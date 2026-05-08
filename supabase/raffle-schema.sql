-- ─────────────────────────────────────────────────────────────
-- BURN RAFFLE SCHEMA
-- Every confirmed burn becomes raffle entries.
-- 1,000 $CHOGI burned = 1 entry (configurable per round).
-- Admin runs a draw weekly (or whenever) and stores the winner.
-- ─────────────────────────────────────────────────────────────

-- ─── ROUNDS: each "season" of the raffle ─────────────────────
create table if not exists chogi_raffle_rounds (
  round_id      bigserial primary key,
  title         text not null,                    -- e.g. "Week of 2026-05-08"
  prize         text not null default 'TBA',      -- human-readable prize
  prize_image   text,                              -- optional URL
  entries_per_k int not null default 1,           -- entries per 1k chogi burned
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,                       -- null = open
  drawn_at      timestamptz,
  winner_wallet text,
  winner_tx     text,
  draw_proof    text,                              -- block hash, VRF seed, etc.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists idx_raffle_active on chogi_raffle_rounds(is_active, starts_at desc);

-- ─── ENTRIES: one per confirmed burn ─────────────────────────
create table if not exists chogi_raffle_entries (
  id            bigserial primary key,
  round_id      bigint not null references chogi_raffle_rounds(round_id) on delete cascade,
  wallet        text not null,
  burn_tx       text unique not null,             -- on-chain dedupe key
  burn_amount   numeric not null,                 -- whole $CHOGI burned (no decimals)
  entries       int not null,                     -- = floor(burn_amount / 1000) * round.entries_per_k
  created_at    timestamptz not null default now()
);

create index if not exists idx_raffle_entries_round_wallet
  on chogi_raffle_entries(round_id, wallet);
create index if not exists idx_raffle_entries_round_created
  on chogi_raffle_entries(round_id, created_at desc);

-- ─── views: aggregate entries per wallet per round ───────────
create or replace view chogi_raffle_leaderboard as
  select
    round_id,
    wallet,
    sum(entries) as total_entries,
    sum(burn_amount) as total_burned,
    count(*) as burn_count,
    max(created_at) as last_burn_at
  from chogi_raffle_entries
  group by round_id, wallet;

-- ─── RLS — public read everything; writes server-only ────────
alter table chogi_raffle_rounds  enable row level security;
alter table chogi_raffle_entries enable row level security;

drop policy if exists "rounds_read_all" on chogi_raffle_rounds;
create policy "rounds_read_all" on chogi_raffle_rounds for select using (true);

drop policy if exists "entries_read_all" on chogi_raffle_entries;
create policy "entries_read_all" on chogi_raffle_entries for select using (true);

-- explicit anon-deny for writes (server uses service key, bypasses RLS)
create policy "rounds_anon_no_write" on chogi_raffle_rounds
  for all to anon, authenticated using (false) with check (false);
create policy "entries_anon_no_write" on chogi_raffle_entries
  for all to anon, authenticated using (false) with check (false);

-- ─── seed an open round ──────────────────────────────────────
insert into chogi_raffle_rounds (title, prize, entries_per_k)
select 'GENESIS RAFFLE · WEEK 1', 'TBA · prize reveal soon', 1
where not exists (select 1 from chogi_raffle_rounds where is_active = true);
