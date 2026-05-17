-- Run this once in Supabase SQL editor (chogi.xyz project)
-- Project: cuqhqcmrgpdjlhyqztnc.supabase.co

-- ────────────────────────────────────────────────────────────
-- The KILL FEED — public wall of CHOGI sellers + diamond hands
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chogi_killfeed (
  id            BIGSERIAL PRIMARY KEY,
  tx_hash       TEXT NOT NULL UNIQUE,         -- on-chain tx hash, dedupes
  wallet        TEXT NOT NULL,                -- the seller's address
  side          TEXT NOT NULL,                -- 'sell' or 'buy' (we feed both)
  amount_chogi  NUMERIC,                      -- amount of CHOGI moved (decimal)
  amount_usd    NUMERIC,                      -- USD value at time of trade
  insult        TEXT,                         -- random epitaph for sells; brag for buys
  block_number  BIGINT,                       -- for ordering/dedup safety
  resurrected   BOOLEAN NOT NULL DEFAULT FALSE, -- true if user paid to clear tombstone
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_killfeed_created   ON chogi_killfeed(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_killfeed_wallet    ON chogi_killfeed(wallet);
CREATE INDEX IF NOT EXISTS idx_killfeed_side      ON chogi_killfeed(side);
CREATE INDEX IF NOT EXISTS idx_killfeed_amount    ON chogi_killfeed(amount_usd DESC);
CREATE INDEX IF NOT EXISTS idx_killfeed_block     ON chogi_killfeed(block_number DESC);

-- ────────────────────────────────────────────────────────────
-- Cursor table — tracks the last block we polled, so the cron
-- doesn't re-scan the whole chain on every run.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chogi_killfeed_cursor (
  id                INT PRIMARY KEY DEFAULT 1,    -- single-row table
  last_block        BIGINT NOT NULL DEFAULT 0,
  last_polled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);

-- Seed the cursor with current block-ish so first run doesn't scan history.
-- You can manually adjust this in the table editor to whatever block you want
-- the feed to start tracking from. Default = 0 means "start from genesis"
-- which the poller will catch up from in chunks.
INSERT INTO chogi_killfeed_cursor (id, last_block) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- RLS — public reads, writes via service key only
-- ────────────────────────────────────────────────────────────

ALTER TABLE chogi_killfeed       ENABLE ROW LEVEL SECURITY;
ALTER TABLE chogi_killfeed_cursor ENABLE ROW LEVEL SECURITY;

-- Anyone (anon) can read the killfeed
DROP POLICY IF EXISTS "killfeed_read_all" ON chogi_killfeed;
CREATE POLICY "killfeed_read_all" ON chogi_killfeed
  FOR SELECT USING (TRUE);

-- Service key can write/update
DROP POLICY IF EXISTS "killfeed_write_service" ON chogi_killfeed;
CREATE POLICY "killfeed_write_service" ON chogi_killfeed
  FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- Cursor is service-only (no public reads of internals)
DROP POLICY IF EXISTS "cursor_service_only" ON chogi_killfeed_cursor;
CREATE POLICY "cursor_service_only" ON chogi_killfeed_cursor
  FOR ALL USING (TRUE) WITH CHECK (TRUE);
