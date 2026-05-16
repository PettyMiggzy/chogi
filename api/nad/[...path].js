// /api/nad/[...path].js
// Server-side proxy for api.nadapp.net — Chogi edition.
//
// Why: nad.fun caps requests at 100 req/min per API key. With many concurrent
// users on /hub, a single key in the browser exhausts the budget fast. This
// proxy:
//   1. Rotates across 3 API keys (random pick per request) = 300 req/min pool
//   2. Caches GET responses at Vercel's edge (s-maxage=20, SWR=60)
//   3. Keeps the keys server-side — never reach the browser
//
// Browser side calls /api/nad/order/creation_time?page=1
// We forward to     https://api.nadapp.net/order/creation_time?page=1
// with X-API-Key auto-injected from the rotation pool.

const NAD_KEYS = [
  'nadfun_VxihwpWj2euHYZUHfpSqBP1r8CLi39Dv',  // Chogi Hub
  'nadfun_kNUi30DPJaLu7eFGWIUiBNCLOIwYT0OP',  // Chogi Hub 2
  'nadfun_2xM38qnw5dZppF5ElhcOi2bGNaFNueyP',  // Spare (shared w/ MonWolf)
];

const BASE = 'https://api.nadapp.net';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const pathSegments = req.query.path || [];
    const pathStr = Array.isArray(pathSegments) ? pathSegments.join('/') : String(pathSegments);

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === 'path') continue;
      if (Array.isArray(v)) v.forEach(vv => params.append(k, vv));
      else if (v !== undefined && v !== null) params.append(k, String(v));
    }
    const qs = params.toString();
    const targetUrl = `${BASE}/${pathStr}${qs ? '?' + qs : ''}`;

    const apiKey = NAD_KEYS[Math.floor(Math.random() * NAD_KEYS.length)];

    const upstreamOpts = {
      method: req.method,
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      upstreamOpts.headers['Content-Type'] = 'application/json';
      if (req.body !== undefined && req.body !== null) {
        upstreamOpts.body = typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
      }
    }

    const upstream = await fetch(targetUrl, upstreamOpts);

    const rl = upstream.headers.get('x-ratelimit-limit');
    const rr = upstream.headers.get('x-ratelimit-remaining');
    if (rl) res.setHeader('X-RL-Limit', rl);
    if (rr) res.setHeader('X-RL-Remaining', rr);

    if (req.method === 'GET' && upstream.ok) {
      res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.status(upstream.status);

    const text = await upstream.text();
    res.send(text);
  } catch (e) {
    console.error('nad proxy crashed:', e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'proxy failed', detail: e.message });
  }
};
