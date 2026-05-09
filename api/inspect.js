// /api/inspect.js — Token snapshot + AI verdict
// POST { wallet, token } → on-chain reads + DexScreener data + GPT verdict.

import { checkHolder, RPC_URL } from './_lib/holder-check.js';
import { isBlocked } from './blocklist.js';

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

// ─── ABI helpers (no ethers in serverless to keep cold-start small) ───
function decodeString(hex) {
  if (!hex || hex === '0x' || hex.length < 130) {
    // Possibly bytes32-style symbol/name
    if (hex && hex.length === 66) {
      try {
        const bytes = hex.slice(2).match(/.{2}/g).map(b => parseInt(b,16));
        const cleaned = bytes.filter(b => b > 0);
        return Buffer.from(cleaned).toString('utf8').replace(/[^\x20-\x7e]/g,'').trim();
      } catch { return ''; }
    }
    return '';
  }
  try {
    const lenHex = hex.slice(2 + 64, 2 + 128);
    const len = parseInt(lenHex, 16);
    if (!len || len > 256) return '';
    const dataHex = hex.slice(2 + 128, 2 + 128 + len * 2);
    const bytes = dataHex.match(/.{2}/g).map(b => parseInt(b,16));
    return Buffer.from(bytes).toString('utf8').trim();
  } catch { return ''; }
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function decodeAddress(hex) {
  if (!hex || hex.length < 66) return null;
  return '0x' + hex.slice(-40);
}

const SEL = {
  name:        '0x06fdde03',
  symbol:      '0x95d89b41',
  decimals:    '0x313ce567',
  totalSupply: '0x18160ddd',
  owner:       '0x8da5cb5b'
};

async function readToken(addr) {
  const calls = ['name','symbol','decimals','totalSupply','owner'];
  const results = await Promise.all(calls.map(async k => {
    try { return await rpc('eth_call', [{ to: addr, data: SEL[k] }, 'latest']); }
    catch { return null; }
  }));
  return {
    name:        decodeString(results[0]) || '',
    symbol:      decodeString(results[1]) || '',
    decimals:    results[2] ? Number(decodeUint(results[2])) : 18,
    totalSupply: results[3] ? decodeUint(results[3]) : 0n,
    owner:       results[4] ? decodeAddress(results[4]) : null,
    has_owner_fn: !!results[4]
  };
}

async function readDex(addr) {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr);
    const j = await r.json();
    if (!j.pairs || j.pairs.length === 0) return null;
    const pair = j.pairs.sort((a,b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const ageDays = pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 86400000) : null;
    return {
      price_usd:     pair.priceUsd ? Number(pair.priceUsd) : null,
      change_24h:    pair.priceChange?.h24 !== undefined ? Number(pair.priceChange.h24) : null,
      liquidity_usd: pair.liquidity?.usd ? Number(pair.liquidity.usd) : null,
      volume_24h:    pair.volume?.h24 ? Number(pair.volume.h24) : null,
      market_cap:    pair.marketCap || pair.fdv || null,
      pair_age_days: ageDays,
      pair_addr:     pair.pairAddress,
      dex:           pair.dexId
    };
  } catch { return null; }
}

const SYSTEM_PROMPT = `You are CHOGI, the cyborg dog CTO. You're handed a snapshot of a token (on-chain metadata + DEX data) and you give a brutal honest read on whether it looks legit, suspicious, or actively dangerous. Terse, opinionated, no padding.

Output format MUST be:

## CHOGI'S READ
[2-4 sentences. What is this thing? What's the vibe? Who would care?]

## 🚩 WATCHLIST
[Bullet list of anything sketchy or worth flagging. Look at: tiny liquidity, brand-new pair, owner not renounced, weird supply (too round, too uneven), no DEX listing, etc. If clean, write "Nothing obvious — still verify the contract code in /decode before depositing."]

## 📊 RISK SCORE
[ONE of: LOW / MEDIUM / HIGH / UNRATED] — [one sentence why]

Rules:
- Liquidity under $5K = high concern.
- Pair age under 7 days = elevated concern.
- Owner not renounced + tiny liq + new pair = HIGH risk, say so.
- Don't speculate on price action. Stick to what the snapshot shows.
- If DEX data is missing entirely, say "Not on any DEX yet — can't price-check."`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'AI not configured' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid json' }); }

  const { wallet, token } = body || {};
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return res.status(400).json({ error: 'invalid wallet' });
  if (!token  || !/^0x[a-fA-F0-9]{40}$/.test(token))  return res.status(400).json({ error: 'invalid token address' });

  // Blocklist (banned wallets) — runs BEFORE holder check so banned addresses
  // can't probe whether they'd otherwise pass the gate.
  if (isBlocked(wallet)) {
    return res.status(403).json({ error: 'wallet blocked' });
  }

  // Holder check (wallet + staked CHOGI)
  const gate = await checkHolder(wallet);
  if (!gate.ok) {
    return res.status(403).json({ error: gate.reason, held: gate.held });
  }

  // Parallel fetch
  let tokenInfo, dexInfo;
  try {
    [tokenInfo, dexInfo] = await Promise.all([readToken(token), readDex(token)]);
  } catch (e) {
    return res.status(502).json({ error: 'data fetch failed: ' + e.message });
  }
  if (!tokenInfo || (!tokenInfo.name && !tokenInfo.symbol && tokenInfo.totalSupply === 0n)) {
    return res.status(404).json({ error: 'No ERC-20 found at that address on Monad.' });
  }

  const supplyHuman = tokenInfo.totalSupply > 0n
    ? Number(tokenInfo.totalSupply / (10n ** BigInt(Math.max(0, tokenInfo.decimals - 6)))) / 1_000_000
    : 0;

  const isRenounced = tokenInfo.owner === '0x0000000000000000000000000000000000000000' ||
                      tokenInfo.owner === '0x000000000000000000000000000000000000dead' ||
                      tokenInfo.owner === null;

  const snapshot = {
    address:        token,
    name:           tokenInfo.name || '?',
    symbol:         tokenInfo.symbol || '?',
    decimals:       tokenInfo.decimals,
    total_supply:   supplyHuman,
    owner:          tokenInfo.owner && tokenInfo.owner !== '0x0000000000000000000000000000000000000000' ? tokenInfo.owner : null,
    owner_renounced: isRenounced,
    price_usd:      dexInfo?.price_usd ?? null,
    change_24h:     dexInfo?.change_24h ?? null,
    liquidity_usd:  dexInfo?.liquidity_usd ?? null,
    volume_24h:     dexInfo?.volume_24h ?? null,
    market_cap:     dexInfo?.market_cap ?? null,
    pair_age_days:  dexInfo?.pair_age_days ?? null,
    dex:            dexInfo?.dex ?? null,
    on_dex:         !!dexInfo
  };

  // AI verdict
  let verdict;
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role:'system', content: SYSTEM_PROMPT },
          { role:'user',   content: 'Token snapshot:\n\n```json\n' + JSON.stringify(snapshot, null, 2) + '\n```' }
        ],
        max_tokens: 800,
        temperature: 0.3
      })
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('OpenAI err', aiRes.status, errText.slice(0,200));
      verdict = '## CHOGI\'S READ\nAI verdict failed — snapshot data still loaded above.\n\n## 📊 RISK SCORE\nUNRATED — couldn\'t complete the read.';
    } else {
      const data = await aiRes.json();
      verdict = data.choices?.[0]?.message?.content?.trim() || 'No verdict generated.';
    }
  } catch (e) {
    verdict = '## CHOGI\'S READ\nAI verdict failed — snapshot data still loaded above.\n\n## 📊 RISK SCORE\nUNRATED — couldn\'t complete the read.';
  }

  return res.status(200).json({ snapshot, verdict });
}
