-- ─────────────────────────────────────────────────────────────
-- MULTI-PET MIGRATION
-- Run AFTER chat-schema.sql. This migrates the schema to support
-- multiple pets per wallet + death/revive mechanics.
-- ─────────────────────────────────────────────────────────────

-- 1. Drop the old wallet-as-PK constraint, add pet_id UUID column
alter table chogi_pets drop constraint if exists chogi_pets_pkey;

alter table chogi_pets add column if not exists pet_id uuid default gen_random_uuid();

-- For pre-existing rows that had wallet as PK, give them a pet_id
update chogi_pets set pet_id = gen_random_uuid() where pet_id is null;

-- Now make pet_id the new primary key
alter table chogi_pets add primary key (pet_id);

-- Wallet becomes a regular indexed column (multiple pets can share it)
create index if not exists idx_chogi_pets_wallet on chogi_pets(wallet);

-- 2. Add death/revive columns
alter table chogi_pets add column if not exists died_at timestamptz;
alter table chogi_pets add column if not exists death_cause text; -- 'starvation' | 'thirst' | 'sadness'
alter table chogi_pets add column if not exists revived_count int not null default 0;
alter table chogi_pets add column if not exists buried boolean not null default false;
-- when stat hit 0
alter table chogi_pets add column if not exists critical_since bigint;

-- 3. chat table needs pet_id to scope chat history per-pet (not per-wallet)
alter table chogi_pet_chats add column if not exists pet_id uuid;

-- backfill: for legacy chats that have a wallet but no pet_id, link them to that wallet's first pet
update chogi_pet_chats c
set pet_id = (
  select pet_id from chogi_pets p
  where p.wallet = c.wallet
  order by p.created_at asc
  limit 1
)
where c.pet_id is null;

create index if not exists idx_chogi_chats_pet on chogi_pet_chats(pet_id, created_at desc);

-- 4. events table: also scope by pet_id when known
alter table chogi_pet_events add column if not exists pet_id uuid;
create index if not exists idx_chogi_events_pet on chogi_pet_events(pet_id, created_at desc);

-- 5. RLS already in place (pets_read_all etc) — no changes needed since we
-- still don't trust client auth and the burn tx is the source of truth.
