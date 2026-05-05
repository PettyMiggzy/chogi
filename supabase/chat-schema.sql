-- Add bonded flag for chat unlock
alter table chogi_pets add column if not exists bonded boolean not null default false;
alter table chogi_pets add column if not exists bonded_at timestamptz;
alter table chogi_pets add column if not exists bond_tx text;

-- Chat history table
create table if not exists chogi_pet_chats (
  id          bigserial primary key,
  wallet      text not null,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null check (char_length(content) between 1 and 500),
  created_at  timestamptz not null default now()
);

create index if not exists idx_chogi_chats_wallet_time on chogi_pet_chats(wallet, created_at desc);

-- RLS: public read (the user's own chat history is shown to them)
alter table chogi_pet_chats enable row level security;

drop policy if exists "chats_read_all" on chogi_pet_chats;
create policy "chats_read_all" on chogi_pet_chats for select using (true);

-- Insert is server-side only (service_role) — no client writes
-- This prevents users from spoofing pet replies
drop policy if exists "chats_no_anon_insert" on chogi_pet_chats;
-- (no insert policy = anon can't insert. service_role bypasses RLS automatically)
