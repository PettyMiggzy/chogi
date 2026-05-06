// /api/pin.js — Subject Pin endpoint
// Accepts POST { wallet, lat, lng, note? } → derives SUBJECT classification from
// wallet bytes, upserts into chogi_subject_pins (one row per wallet).
//
// Reads happen client-side directly via Supabase REST + Realtime (anon key).
// This endpoint exists only to gate writes — RLS blocks anon writes, service
// key on the server bypasses RLS.

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cuqhqcmrgpdjlhyqztnc.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_KEY) {
    return res.status(500).json({ error: 'storage not configured' });
  }

  // ─── parse + validate ───────────────────────────────────────────────────
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'invalid json' });
  }

  let { wallet, lat, lng, note } = body;

  if (typeof wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'invalid wallet' });
  }
  wallet = wallet.toLowerCase();

  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return res.status(400).json({ error: 'invalid lat' });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'invalid lng' });
  }
  // round to 4 decimals (~11 meters) — discourages hyper-precision tracking
  lat = Math.round(lat * 10000) / 10000;
  lng = Math.round(lng * 10000) / 10000;

  if (note != null) {
    if (typeof note !== 'string') return res.status(400).json({ error: 'invalid note' });
    note = note.trim().slice(0, 60);   // hard cap
    if (note === '') note = null;
  }

  // ─── derive Subject classification (matches /subject page exactly) ──────
  const a = wallet.slice(2); // 40 hex chars
  const subjectId = String(parseInt(a.slice(-4), 16) % 10000).padStart(4, '0');
  const threats   = ['ALPHA','BETA','GAMMA','DELTA','OMEGA'];
  const biosigns  = ['STABLE','ELEVATED','CRITICAL','UNHINGED','CLASSIFIED'];
  const threat    = threats[parseInt(a.slice(0,2), 16) % 5];
  const biosign   = biosigns[parseInt(a.slice(2,4), 16) % 5];
  const cellLetter = String.fromCharCode(65 + (parseInt(a.slice(8,10), 16) % 26));
  const cellNum    = (parseInt(a.slice(10,12), 16) % 99) + 1;
  const cell       = cellLetter + '-' + String(cellNum).padStart(2,'0');

  // ─── upsert via Supabase REST ───────────────────────────────────────────
  const url = SUPABASE_URL + '/rest/v1/chogi_subject_pins';
  const row = { wallet, subject_id: subjectId, threat, biosign, cell, lat, lng, note };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('supabase upsert failed', r.status, text);
      return res.status(502).json({ error: 'storage error', detail: r.status });
    }
    const inserted = await r.json();
    return res.status(200).json({ ok: true, pin: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (e) {
    console.error('pin upsert exception', e);
    return res.status(500).json({ error: 'storage exception' });
  }
}
