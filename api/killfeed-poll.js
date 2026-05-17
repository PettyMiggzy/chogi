// /api/killfeed-poll.js
// POLLER — runs every 1 min via Vercel cron.
//
// Uses nad.fun's /trade/swap-history API instead of eth_getLogs.
// Way simpler: nad.fun already classifies BUY/SELL, computes USD value,
// includes tx_hash + wallet. No RPC limits. No chunking. No pair address
// lookup. One HTTP call per page.
//
// Dedup is purely via tx_hash UNIQUE constraint on chogi_killfeed.
// We pull the most recent N pages, try to insert each, dupes get rejected
// silently. Cursor table not needed.

import { randomInsult } from './_lib/insults.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cuqhqcmrgpdjlhyqztnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CHOGI_TOKEN = '0x5E1b1A14c8758104B8560514e94ab8320e587777';
const NADFUN_BASE = 'https://api.nadapp.net';

const SELL_USD_FLOOR = 100;
const BUY_USD_FLOOR  = 250;
// 2 pages × 50 = last 100 swaps. Comfortably more than 1 minute of
// activity even on a busy day, so we never miss anything between runs.
const PAGES_PER_RUN = 2;
const PER_PAGE = 50;

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

async function sb(path, opts = {}) {
  const r = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return r;
}

async function fetchSwaps(page) {
  const url = `${NADFUN_BASE}/trade/swap-history/${CHOGI_TOKEN}?page=${page}&limit=${PER_PAGE}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`nad.fun swap-history ${r.status}`);
  const j = await r.json();
  return j.swaps || [];
}

async function insertKill(row) {
  const r = await sb('/rest/v1/chogi_killfeed', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  return r.status === 201 || r.status === 200;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method' });
  }
  if (!SUPABASE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_SERVICE_KEY' });
  }

  try {
    let totalScanned = 0;
    let inserted = 0;
    let belowFloor = 0;
    let dupes = 0;

    for (let page = 1; page <= PAGES_PER_RUN; page++) {
      const swaps = await fetchSwaps(page);
      if (swaps.length === 0) break;

      for (const s of swaps) {
        totalScanned++;
        const wallet = (s.account_info?.account_id || '').toLowerCase();
        const swap = s.swap_info || {};
        const side = (swap.event_type || '').toLowerCase();
        const usd = parseFloat(swap.value || '0');
        const tokenAmountWei = swap.token_amount ? BigInt(swap.token_amount) : 0n;
        const amountChogi = Number(tokenAmountWei) / 1e18;
        const txHash = (swap.transaction_hash || '').toLowerCase();
        const ts = Number(swap.created_at || 0);

        if (!WALLET_RE.test(wallet)) continue;
        if (!txHash) continue;
        if (side !== 'buy' && side !== 'sell') continue;

        const floor = side === 'sell' ? SELL_USD_FLOOR : BUY_USD_FLOOR;
        if (usd < floor) { belowFloor++; continue; }

        const row = {
          tx_hash: txHash,
          wallet,
          side,
          amount_chogi: amountChogi,
          amount_usd: usd,
          insult: side === 'sell' ? randomInsult() : null,
          block_number: null,
          created_at: ts > 0 ? new Date(ts * 1000).toISOString() : undefined,
        };
        const ok = await insertKill(row);
        if (ok) inserted++; else dupes++;
      }
    }

    return res.status(200).json({
      ok: true,
      pages: PAGES_PER_RUN,
      totalScanned,
      inserted,
      belowFloor,
      dupes,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
