// /api/killfeed.js
// READ-ONLY public endpoint for the kill feed wall.
//
// GET /api/killfeed
//   ?tab=recent  → newest tombstones (default)
//   ?tab=biggest → biggest dumps ever
//   ?tab=diamond → biggest buys ever (the inverse wall)
//   ?limit=N     → 1-100, default 50
//   ?wallet=0x.. → filter to one wallet
//
// All reads go directly to Supabase via service key (RLS allows
// anon SELECT but we use service key so we don't expose a public
// anon URL — keeps the dashboard cleaner).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cuqhqcmrgpdjlhyqztnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

async function sb(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`supabase ${r.status}: ${t.slice(0, 120)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (!SUPABASE_KEY) {
    return res.status(500).json({ error: 'storage not configured' });
  }

  const tab = (req.query.tab || 'recent').toString();
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const walletFilter = req.query.wallet ? String(req.query.wallet).toLowerCase() : null;
  if (walletFilter && !WALLET_RE.test(walletFilter)) {
    return res.status(400).json({ error: 'invalid wallet' });
  }

  let query = '/rest/v1/chogi_killfeed?';
  const params = new URLSearchParams();
  params.set('select', 'id,tx_hash,wallet,side,amount_chogi,amount_usd,insult,block_number,resurrected,created_at');
  params.set('limit', String(limit));

  if (tab === 'biggest') {
    params.set('side', 'eq.sell');
    params.set('resurrected', 'eq.false');
    params.set('order', 'amount_usd.desc.nullslast');
  } else if (tab === 'diamond') {
    params.set('side', 'eq.buy');
    params.set('order', 'amount_usd.desc.nullslast');
  } else {
    // recent — default
    params.set('order', 'created_at.desc');
  }
  if (walletFilter) params.set('wallet', `eq.${walletFilter}`);

  try {
    const rows = await sb(query + params.toString());
    // Also compute some summary stats for the page header
    const stats = await sb('/rest/v1/chogi_killfeed?select=side,amount_usd&limit=10000');
    let totalKills = 0, totalDumpUsd = 0, totalDiamondUsd = 0, biggest = 0;
    for (const r of stats) {
      if (r.side === 'sell') {
        totalKills++;
        const u = Number(r.amount_usd) || 0;
        totalDumpUsd += u;
        if (u > biggest) biggest = u;
      } else if (r.side === 'buy') {
        totalDiamondUsd += Number(r.amount_usd) || 0;
      }
    }
    return res.status(200).json({
      tab,
      rows,
      stats: {
        totalKills,
        totalDumpUsd,
        totalDiamondUsd,
        biggestDump: biggest,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
