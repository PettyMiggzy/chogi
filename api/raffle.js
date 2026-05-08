// /api/raffle.js — burn raffle entry endpoint
//
// GET  /api/raffle              → { active_round, leaderboard, recent }
// GET  /api/raffle?round=N      → same scoped to a round
// POST /api/raffle              → record a confirmed burn
//   body: { wallet, burn_tx, burn_amount }
//   - wallet validated (regex)
//   - burn_tx must be 0x...64 hex
//   - we re-check the tx on-chain BEFORE writing (anti-spoof)
//   - dedup'd via burn_tx unique constraint
//
// Reads happen direct from Supabase via anon key (RLS read-all).
// Writes go through here so we can verify the burn on-chain.

import { isBlocked } from './blocklist.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cuqhqcmrgpdjlhyqztnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const CHOGI_TOKEN = '0x5E1b1A14c8758104B8560514e94ab8320e587777'.toLowerCase();
const DEAD = '0x000000000000000000000000000000000000dead';

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const TXHASH_RE = /^0x[a-fA-F0-9]{64}$/;

function pad32(addr) {
  return '0x000000000000000000000000' + addr.replace(/^0x/, '').toLowerCase();
}

async function sb(path, opts) {
  const r = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(opts && opts.headers || {})
    }
  });
  return r;
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

// Verify the burn on-chain:
//  - tx hash exists, status = success
//  - logs include a Transfer from `wallet` → DEAD on the CHOGI contract
//  - sum the values, return whole-token amount
// Returns null if anything's off.
async function verifyBurn(walletLc, txHash) {
  let receipt;
  try {
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  } catch (e) {
    return null;
  }
  if (!receipt || !receipt.status) return null;
  if (receipt.status !== '0x1') return null; // failed tx

  const fromTopic = pad32(walletLc).toLowerCase();
  const deadTopic = pad32(DEAD).toLowerCase();

  let totalWei = 0n;
  for (const log of receipt.logs || []) {
    if ((log.address || '').toLowerCase() !== CHOGI_TOKEN) continue;
    const topics = log.topics || [];
    if (topics.length < 3) continue;
    if (topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topics[1].toLowerCase() !== fromTopic) continue;
    if (topics[2].toLowerCase() !== deadTopic) continue;
    try {
      totalWei += BigInt(log.data);
    } catch (e) { /* ignore malformed */ }
  }
  if (totalWei === 0n) return null;
  // return whole-token amount (CHOGI has 18 decimals)
  return Number(totalWei / 1000000000000000000n);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'storage not configured' });

  // ── GET ─────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      let roundId = req.query.round ? Number(req.query.round) : null;
      if (!roundId) {
        const r = await sb('/rest/v1/chogi_raffle_rounds?is_active=eq.true&select=*&order=starts_at.desc&limit=1');
        const rows = await r.json();
        if (!rows || !rows[0]) return res.status(200).json({ active_round: null, leaderboard: [], recent: [] });
        roundId = rows[0].round_id;
      }
      const [roundRes, lbRes, recentRes, walletRes] = await Promise.all([
        sb(`/rest/v1/chogi_raffle_rounds?round_id=eq.${roundId}&limit=1`),
        sb(`/rest/v1/chogi_raffle_leaderboard?round_id=eq.${roundId}&order=total_entries.desc&limit=20`),
        sb(`/rest/v1/chogi_raffle_entries?round_id=eq.${roundId}&select=wallet,burn_amount,entries,burn_tx,created_at&order=created_at.desc&limit=15`),
        req.query.wallet && WALLET_RE.test(req.query.wallet)
          ? sb(`/rest/v1/chogi_raffle_leaderboard?round_id=eq.${roundId}&wallet=eq.${req.query.wallet.toLowerCase()}&limit=1`)
          : Promise.resolve(null)
      ]);
      const round = (await roundRes.json())[0] || null;
      const leaderboard = await lbRes.json();
      const recent = await recentRes.json();
      const me = walletRes ? (await walletRes.json())[0] || null : null;
      return res.status(200).json({ active_round: round, leaderboard, recent, me });
    } catch (e) {
      console.error('raffle GET:', e);
      return res.status(502).json({ error: 'load failed' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST or GET only' });

  // ── POST ────────────────────────────────────────────────
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (e) { return res.status(400).json({ error: 'bad json' }); }

  let { wallet, burn_tx } = body || {};
  if (typeof wallet !== 'string' || !WALLET_RE.test(wallet)) {
    return res.status(400).json({ error: 'bad wallet' });
  }
  if (typeof burn_tx !== 'string' || !TXHASH_RE.test(burn_tx)) {
    return res.status(400).json({ error: 'bad tx hash' });
  }
  const walletLc = wallet.toLowerCase();
  const txLc = burn_tx.toLowerCase();
  if (isBlocked(walletLc)) {
    return res.status(403).json({ error: 'wallet blocked', code: 'FLAGGED' });
  }

  // verify the burn on-chain (anti-spoof)
  const burnAmount = await verifyBurn(walletLc, txLc);
  if (burnAmount === null) {
    return res.status(400).json({ error: 'tx did not burn $CHOGI from this wallet' });
  }
  if (burnAmount < 1) {
    return res.status(400).json({ error: 'burn too small to count' });
  }

  // find the active round + entry rate
  const roundRes = await sb('/rest/v1/chogi_raffle_rounds?is_active=eq.true&select=round_id,entries_per_k&order=starts_at.desc&limit=1');
  const rows = await roundRes.json();
  if (!rows || !rows[0]) return res.status(400).json({ error: 'no active round' });
  const round = rows[0];

  const entries = Math.floor(burnAmount / 1000) * Number(round.entries_per_k || 1);
  if (entries < 1) {
    return res.status(200).json({ ok: true, entries: 0, note: 'burn under 1K threshold' });
  }

  // insert (unique on burn_tx so retries don't double-count)
  const ins = await sb('/rest/v1/chogi_raffle_entries', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      round_id: round.round_id,
      wallet: walletLc,
      burn_tx: txLc,
      burn_amount: burnAmount,
      entries
    })
  });
  if (ins.status === 409) {
    // already recorded
    return res.status(200).json({ ok: true, duplicate: true, entries });
  }
  if (!ins.ok) {
    const text = await ins.text();
    console.error('raffle insert failed', ins.status, text);
    return res.status(502).json({ error: 'insert failed' });
  }
  const inserted = await ins.json();
  return res.status(200).json({ ok: true, entry: inserted[0] || null, entries });
}
