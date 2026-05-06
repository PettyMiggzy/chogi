// /api/log-blocked-attempt.js
// Called by /js/blocklist.js when a blocked wallet connects.
// Captures the visit's IP and stores wallet/IP/timestamp/userAgent in
// Supabase table chogi_blocked_attempts so you can review and decide
// which IPs to permanently add to /middleware.js BLOCKED_IPS.
//
// Only logs attempts from wallets that ARE actually on the blocklist —
// no general visitor surveillance.

import { isBlocked } from './blocklist.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }

  let wallet = body.wallet;
  const fingerprint = (body.fingerprint || '').toString().slice(0, 64);
  const reason = (body.reason || '').toString().slice(0, 32);

  if (typeof wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'invalid wallet' });
  }
  wallet = wallet.toLowerCase();

  // Zero address = device-match capture (fingerprint alone, no wallet)
  const isZeroWallet = wallet === '0x0000000000000000000000000000000000000000';

  // ── ONLY LOG IF WALLET IS BLOCKLISTED OR IT'S A DEVICE-MATCH CAPTURE ───
  if (!isZeroWallet && !isBlocked(wallet)) {
    return res.status(200).json({ ok: true, logged: false });
  }

  // ── EXTRACT IP ──────────────────────────────────────────────────────────
  const ip =
    (req.headers['cf-connecting-ip'] || '').toString().trim() ||
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    (req.headers['x-real-ip'] || '').toString().trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 200);
  const referrer = (req.headers['referer'] || req.headers['referrer'] || '').toString().slice(0, 200);

  // ── WRITE TO SUPABASE ───────────────────────────────────────────────────
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cuqhqcmrgpdjlhyqztnc.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_KEY) {
    // Even without storage, return success so the client doesn't retry forever
    console.error('log-blocked-attempt: no SUPABASE_KEY env var');
    return res.status(200).json({ ok: true, logged: false, reason: 'no key' });
  }

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/chogi_blocked_attempts', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        wallet,
        ip,
        user_agent: userAgent,
        referrer,
        fingerprint: fingerprint || null,
        reason: reason || (isZeroWallet ? 'device-match' : 'wallet-match'),
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('log-blocked-attempt: supabase write failed', r.status, text);
      return res.status(200).json({ ok: true, logged: false });
    }
    return res.status(200).json({ ok: true, logged: true });
  } catch (e) {
    console.error('log-blocked-attempt exception', e);
    return res.status(200).json({ ok: true, logged: false });
  }
}
