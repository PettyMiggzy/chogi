-- ─────────────────────────────────────────────────────────────
-- LOCK DOWN PET WRITES (RLS hardening)
-- Run AFTER multi-pet-schema.sql.
--
-- Before this migration: anon key could insert/update any pet row,
-- which let attackers flip another wallet's `bonded`, edit pet names
-- (XSS payload via pet.name), or burn another user's daily AI quota.
--
-- After this migration:
--   * anon key can READ everything (pets are public game state)
--   * anon key CANNOT write — all writes must come through the server
--     using SUPABASE_SERVICE_KEY (which bypasses RLS).
--   * /api endpoints now own all mutation paths.
--
-- Client code paths that previously wrote directly to chogi_pets must
-- be migrated to a /api/pet endpoint that re-validates ownership and
-- input shape before forwarding to Supabase.
-- ─────────────────────────────────────────────────────────────

-- pets ───────────────────────────────────────────────────────
drop policy if exists "pets_write_all"  on chogi_pets;
drop policy if exists "pets_update_all" on chogi_pets;
drop policy if exists "pets_delete_all" on chogi_pets;

-- (read policy `pets_read_all` is intentionally kept — pets are public)

-- explicit anon-deny for inserts/updates/deletes; service_role bypasses RLS
create policy "pets_anon_no_insert" on chogi_pets
  for insert to anon, authenticated
  with check (false);

create policy "pets_anon_no_update" on chogi_pets
  for update to anon, authenticated
  using (false) with check (false);

create policy "pets_anon_no_delete" on chogi_pets
  for delete to anon, authenticated
  using (false);

-- pet events ─────────────────────────────────────────────────
drop policy if exists "events_write_all" on chogi_pet_events;

create policy "events_anon_no_insert" on chogi_pet_events
  for insert to anon, authenticated
  with check (false);

create policy "events_anon_no_update" on chogi_pet_events
  for update to anon, authenticated
  using (false) with check (false);

create policy "events_anon_no_delete" on chogi_pet_events
  for delete to anon, authenticated
  using (false);

-- chats already server-only (writes only via /api/chat-pet),
-- but be explicit so reads remain public for transcript pages.
alter table if exists chogi_pet_chats enable row level security;

drop policy if exists "chats_read_all"   on chogi_pet_chats;
drop policy if exists "chats_write_all"  on chogi_pet_chats;
drop policy if exists "chats_update_all" on chogi_pet_chats;

create policy "chats_read_all" on chogi_pet_chats
  for select using (true);

create policy "chats_anon_no_insert" on chogi_pet_chats
  for insert to anon, authenticated
  with check (false);

create policy "chats_anon_no_update" on chogi_pet_chats
  for update to anon, authenticated
  using (false) with check (false);

-- ─────────────────────────────────────────────────────────────
-- Optional: forbid pet name from containing HTML-ish chars.
-- Defense-in-depth alongside escapeHtml() on the client.
-- ─────────────────────────────────────────────────────────────
alter table chogi_pets
  drop constraint if exists chogi_pets_name_safe;

alter table chogi_pets
  add constraint chogi_pets_name_safe
  check (
    name is null
    or (
      char_length(name) <= 32
      and name !~ '[<>"''`]'    -- no angle brackets or quote chars
      and name !~ E'[\\u0000-\\u001f]'  -- no control chars
    )
  );
