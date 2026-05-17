// /api/killfeed-poll.js
// POLLER — runs every 1 min via Vercel cron.
//
// Watches the Monad chain for CHOGI Transfer events involving the
// liquidity pool addresses (any Transfer to/from a known DEX pair =
// a swap). For each swap, classifies as buy or sell, computes USD
// value, picks a random insult, writes to chogi_killfeed.
//
// Cursor-based: reads chogi_killfeed_cursor.last_block, polls from
// there to current chain head in chunks. Writes back the new cursor.
//
// Dedup: tx_hash is UNIQUE on chogi_killfeed, so even if the cursor
// is rewound or chunks overlap, no duplicate tombstones.
//
// Min thresholds: only sells >= $100 and buys >= $250 get tombstoned.
// This filters out micro-spam and keeps the wall meaningful.

import { randomInsult } from './_lib/insults.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cuqhqcmrgpdjlhyqztnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';

const CHOGI_TOKEN = '0x5e1b1a14c8758104b8560514e94ab8320e587777'.toLowerCase();
// CHOGI/MON pair on Crust (the main LP). If you have a second pair, add it.
// Update this if pair address changes.
const CHOGI_POOLS = [
  // Discovered at runtime from the on-chain pair factory; for now seed
  // empties so the poller treats anything that isn't a known pool as a
  // wallet-to-wallet transfer (ignored). King can add the actual pair
  // address by running the SQL helper or by setting CHOGI_POOLS_CSV env var.
];
const POOLS_FROM_ENV = (process.env.CHOGI_POOLS_CSV || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(s => /^0x[0-9a-f]{40}$/.test(s));
const POOLS = new Set([...CHOGI_POOLS, ...POOLS_FROM_ENV]);

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const SELL_USD_FLOOR = 100;
const BUY_USD_FLOOR  = 250;
const MAX_BLOCK_CHUNK = 500; // play nice with the RPC

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

async function sb(path, opts = {}) {
  const r = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  return r;
}

function topicToAddr(topic) {
  return '0x' + topic.slice(-40);
}

function bnHex(h) {
  if (!h) return 0n;
  return BigInt(h);
}

// Fetch current CHOGI price in USD from dexscreener (any pair, take first).
let _priceCache = { ts: 0, usd: null };
async function getChogiPriceUsd() {
  const now = Date.now();
  if (_priceCache.usd != null && now - _priceCache.ts < 60_000) return _priceCache.usd;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CHOGI_TOKEN}`, {
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error('dexscreener http ' + r.status);
    const j = await r.json();
    const pairs = (j.pairs || []).sort((a, b) =>
      (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0)
    );
    const price = pairs[0]?.priceUsd ? parseFloat(pairs[0].priceUsd) : null;
    if (price) {
      _priceCache = { ts: now, usd: price };
      return price;
    }
  } catch (e) {
    console.warn('price fetch failed', e.message);
  }
  return _priceCache.usd;
}

async function readCursor() {
  const r = await sb('/rest/v1/chogi_killfeed_cursor?id=eq.1&select=last_block');
  if (!r.ok) throw new Error('cursor read failed ' + r.status);
  const rows = await r.json();
  return rows[0]?.last_block ? Number(rows[0].last_block) : 0;
}

async function writeCursor(blockNumber) {
  const r = await sb('/rest/v1/chogi_killfeed_cursor?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({
      last_block: blockNumber,
      last_polled_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error('cursor write failed ' + r.status);
}

async function insertKill(row) {
  const r = await sb('/rest/v1/chogi_killfeed', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  return r.ok;
}

export default async function handler(req, res) {
  // Vercel cron sends an Authorization header we can verify, but for now
  // we just allow GET. If you want to lock it down, check req.headers.authorization.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method' });
  }
  if (!SUPABASE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_SERVICE_KEY' });
  }
  if (POOLS.size === 0) {
    return res.status(200).json({
      ok: false,
      msg: 'CHOGI_POOLS_CSV not set — add pool address(es) as env var',
      example: 'CHOGI_POOLS_CSV=0xabc...,0xdef...',
    });
  }

  try {
    const head = Number(bnHex(await rpc('eth_blockNumber', [])));
    let cursor = await readCursor();
    if (cursor === 0) {
      // First run — start from current head, don't backfill history
      cursor = Math.max(0, head - 100);
    }
    const fromBlock = cursor + 1;
    const toBlock = Math.min(head, fromBlock + MAX_BLOCK_CHUNK);

    if (fromBlock > head) {
      return res.status(200).json({ ok: true, msg: 'caught up', cursor, head });
    }

    // Build filter: Transfer events on CHOGI token contract
    const filter = {
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      address: CHOGI_TOKEN,
      topics: [TRANSFER_TOPIC],
    };
    const logs = await rpc('eth_getLogs', [filter]);

    const priceUsd = await getChogiPriceUsd();
    if (!priceUsd) {
      return res.status(200).json({ ok: false, msg: 'no price', cursor, head });
    }

    let inserted = 0, skipped = 0;
    for (const log of (logs || [])) {
      const fromAddr = topicToAddr(log.topics[1]).toLowerCase();
      const toAddr   = topicToAddr(log.topics[2]).toLowerCase();
      if (!WALLET_RE.test(fromAddr) || !WALLET_RE.test(toAddr)) continue;

      // Detect side: from a pool = buy (pool→wallet), to a pool = sell (wallet→pool)
      const fromIsPool = POOLS.has(fromAddr);
      const toIsPool   = POOLS.has(toAddr);
      if (fromIsPool === toIsPool) {
        skipped++;
        continue;
      }
      const side = fromIsPool ? 'buy' : 'sell';
      const wallet = fromIsPool ? toAddr : fromAddr;

      // Decode amount from data
      const amountWei = bnHex(log.data);
      // CHOGI is 18 decimals
      const amountChogi = Number(amountWei) / 1e18;
      const amountUsd = amountChogi * priceUsd;

      const floor = side === 'sell' ? SELL_USD_FLOOR : BUY_USD_FLOOR;
      if (amountUsd < floor) { skipped++; continue; }

      const row = {
        tx_hash: log.transactionHash.toLowerCase(),
        wallet,
        side,
        amount_chogi: amountChogi,
        amount_usd: amountUsd,
        insult: side === 'sell' ? randomInsult() : null,
        block_number: Number(bnHex(log.blockNumber)),
      };
      const ok = await insertKill(row);
      if (ok) inserted++; else skipped++;
    }

    await writeCursor(toBlock);

    return res.status(200).json({
      ok: true,
      fromBlock,
      toBlock,
      head,
      logs_scanned: logs?.length || 0,
      inserted,
      skipped,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
