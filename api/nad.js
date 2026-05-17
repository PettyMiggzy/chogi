// /api/nad.js
// Server-side proxy for api.nadapp.net — Chogi edition.
// Routes /api/nad/* → https://api.nadapp.net/* with key rotation + edge cache.
//
// NOTE: Chogi's package.json declares "type":"module" so this file must use
// ES module syntax (export default). CommonJS module.exports won't run.

const NAD_KEYS = [
  'nadfun_VxihwpWj2euHYZUHfpSqBP1r8CLi39Dv',  // Chogi Hub
  'nadfun_kNUi30DPJaLu7eFGWIUiBNCLOIwYT0OP',  // Chogi Hub 2
  'nadfun_2xM38qnw5dZppF5ElhcOi2bGNaFNueyP',  // Spare (shared w/ MonWolf)
];

const BASE = 'https://api.nadapp.net';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    let upstreamPath, upstreamQuery = '';

    if (req.query && req.query._p) {
      upstreamPath = Array.isArray(req.query._p) ? req.query._p.join('/') : String(req.query._p);
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (k === '_p') continue;
        if (Array.isArray(v)) v.forEach(vv => params.append(k, vv));
        else if (v !== undefined && v !== null) params.append(k, String(v));
      }
      upstreamQuery = params.toString();
    } else {
      const url = req.url || '';
      const qIdx = url.indexOf('?');
      const pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
      upstreamQuery = qIdx >= 0 ? url.slice(qIdx + 1) : '';
      let rel = pathPart.replace(/^\/api\/nad\/?/, '');
      rel = rel.replace(/^\/+/, '');
      upstreamPath = rel;
    }

    if (!upstreamPath) {
      res.status(400).json({ error: 'missing nad.fun path. Use /api/nad/{endpoint}' });
      return;
    }

    const targetUrl = `${BASE}/${upstreamPath}${upstreamQuery ? '?' + upstreamQuery : ''}`;
    // 2026-05-17: nad.fun deprecated API key auth — endpoints are now public.
    // Sending the (now-invalid) key returns HTTP 401, so we skip the header.

    const upstreamOpts = {
      method: req.method,
      headers: { 'Accept': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      upstreamOpts.headers['Content-Type'] = 'application/json';
      if (req.body !== undefined && req.body !== null) {
        upstreamOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
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
}
