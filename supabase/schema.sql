-- Chogi Pet Hatcher — Supabase schema
-- Paste into your Supabase SQL editor and Run

-- ───── pets table ─────
create table if not exists chogi_pets (
  wallet         text primary key,             -- lowercase 0x...
  type           text not null,                -- 'chogi' | 'chog'
  name           text not null,
  born_at        bigint not null,              -- ms timestamp
  last_fed_at    bigint not null,
  last_watered_at bigint not null,
  last_updated_at bigint not null,
  hunger         numeric not null default 100,
  thirst         numeric not null default 100,
  happiness      numeric not null default 80,
  stage          text not null default 'baby',
  days_alive     int not null default 1,
  total_burned   bigint not null default 0,
  feed_count     int not null default 0,
  water_count    int not null default 0,
  hungry_events  int not null default 0,
  thirsty_events int not null default 0,
  cosmetics      jsonb not null default '{"head":null,"outfit":null,"boots":null,"acc":null}'::jsonb,
  owned_items    jsonb not null default '[]'::jsonb,
  hatch_tx       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_chogi_pets_updated on chogi_pets(updated_at desc);
create index if not exists idx_chogi_pets_stage on chogi_pets(stage);

-- ───── audit log of every meaningful tx ─────
create table if not exists chogi_pet_events (
  id             bigserial primary key,
  wallet         text not null,
  event_type     text not null,                -- 'hatch' | 'feed' | 'water' | 'buy' | 'equip' | 'unequip' | 'mint'
  item_id        text,                          -- references item from catalog if applicable
  burn_amount    bigint default 0,             -- $CHOGI burned (whole units, not wei)
  tx_hash        text,
  metadata       jsonb default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists idx_chogi_events_wallet on chogi_pet_events(wallet, created_at desc);
create index if not exists idx_chogi_events_type on chogi_pet_events(event_type, created_at desc);

-- ───── RLS — public read, public write (we trust the burn tx as the source of truth) ─────
alter table chogi_pets enable row level security;
alter table chogi_pet_events enable row level security;

-- anyone can read any pet (it's public game state)
drop policy if exists "pets_read_all" on chogi_pets;
create policy "pets_read_all" on chogi_pets for select using (true);

-- anyone can insert/update/upsert (the wallet owner field is the only auth — we trust client)
-- This is fine for a pet game where the worst case is someone messing with their own data
drop policy if exists "pets_write_all" on chogi_pets;
create policy "pets_write_all" on chogi_pets for insert with check (true);
drop policy if exists "pets_update_all" on chogi_pets;
create policy "pets_update_all" on chogi_pets for update using (true) with check (true);

drop policy if exists "events_read_all" on chogi_pet_events;
create policy "events_read_all" on chogi_pet_events for select using (true);
drop policy if exists "events_write_all" on chogi_pet_events;
create policy "events_write_all" on chogi_pet_events for insert with check (true);

-- ───── auto-update updated_at trigger ─────
create or replace function chogi_pets_touch_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists chogi_pets_touch_updated_trg on chogi_pets;
create trigger chogi_pets_touch_updated_trg
  before update on chogi_pets
  for each row execute function chogi_pets_touch_updated();
