// /api/rpc.js — server-side JSON-RPC proxy to Monad
//
// All client-side ethers / fetch calls go through here so the QuickNode
// key (or whatever upstream we use) never reaches the browser.
// Set MONAD_RPC=<your full RPC URL with key> in Vercel env vars.
//
// Same-origin only (chogi.xyz → /api/rpc → upstream). The browser sees
// `/api/rpc`; the upstream URL with the secret stays server-side.

const UPSTREAM = process.env.MONAD_RPC || 'https://rpc.monad.xyz';

// JSON-RPC methods we will NOT forward (state-changing or abusive).
// Reads + tx-broadcast are allowed; subscription/filter creation isn't
// useful through HTTP-only and is blocked.
const BLOCKED_METHODS = new Set([
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_uninstallFilter',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'admin_',         // any admin namespace
  'debug_',         // any debug namespace
  'personal_',      // any personal namespace (key-mgmt on some nodes)
  'miner_',
  'txpool_'
]);

function isBlocked(method){
  if (typeof method !== 'string') return true;
  if (BLOCKED_METHODS.has(method)) return true;
  for (const prefix of ['admin_', 'debug_', 'personal_', 'miner_', 'txpool_']) {
    if (method.startsWith(prefix)) return true;
  }
  return false;
}

export default async function handler(req, res) {
  // CORS — same-origin in production, allow * for testing
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'invalid json' });
  }

  // Validate + filter (handle batch + single)
  const reqs = Array.isArray(payload) ? payload : [payload];
  for (const r of reqs) {
    if (!r || typeof r !== 'object') {
      return res.status(400).json({ error: 'bad rpc request' });
    }
    if (isBlocked(r.method)) {
      return res.status(403).json({
        jsonrpc: '2.0',
        id: r.id ?? null,
        error: { code: -32601, message: 'method not allowed via proxy' }
      });
    }
    // soft size cap on params to deter abuse (huge eth_getLogs ranges etc)
    try {
      const s = JSON.stringify(r.params || []);
      if (s.length > 8192) {
        return res.status(413).json({
          jsonrpc: '2.0',
          id: r.id ?? null,
          error: { code: -32602, message: 'params too large' }
        });
      }
    } catch (e) {}
  }

  // Forward to upstream
  let upstreamRes;
  try {
    upstreamRes = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('rpc upstream fetch failed:', e?.message || e);
    return res.status(502).json({
      jsonrpc: '2.0',
      id: payload?.id ?? null,
      error: { code: -32603, message: 'upstream rpc unreachable' }
    });
  }

  const text = await upstreamRes.text();
  res.status(upstreamRes.status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(text);
}
