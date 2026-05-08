// /api/pet.js — server-mediated pet writes
// Replaces direct anon-key writes from the client (which the new RLS
// policies in supabase/lock-rls.sql forbid).
//
// Endpoints:
//   GET  /api/pet?wallet=0x...                  → list wallet's pets
//   GET  /api/pet?pet_id=uuid                   → fetch one pet
//   POST /api/pet  body { wallet, pet }         → upsert (wallet must own pet_id if it exists)
//   POST /api/pet  body { wallet, pet_id, bury:true } → mark buried
//
// We don't have wallet signatures here — same trust model as the rest
// of the site (wallet is supplied by client, we cross-check that any
// existing row's wallet matches before allowing updates). To raise the
// bar, plug in EIP-191/EIP-712 signature verification later.

import { isBlocked } from './blocklist.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cuqhqcmrgpdjlhyqztnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const NAME_RE   = /^[\p{L}\p{N} _\-.!?]{1,32}$/u;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_RE   = /^(chogi|chog)$/;
const STAGE_RE  = /^(baby|kid|teen|adult)$/;

const COSMETIC_KEYS = ['head','outfit','boots','acc'];

function num(v, lo, hi){
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}
function asInt(v, lo, hi){
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}
function asBigInt(v, lo, hi){
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

function sanitizeCosmetics(c){
  if (!c || typeof c !== 'object') return { head:null, outfit:null, boots:null, acc:null };
  const out = {};
  for (const k of COSMETIC_KEYS){
    const v = c[k];
    out[k] = (typeof v === 'string' && v.length <= 32) ? v : null;
  }
  return out;
}
function sanitizeOwnedItems(arr){
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(x => typeof x === 'string' && /^[a-z0-9_\-]{1,32}$/i.test(x))
    .slice(0, 64);
}

// strip the pet payload to a known-good shape; reject if name unsafe
function buildRow(wallet, p){
  if (!p || typeof p !== 'object') return null;
  if (!UUID_RE.test(p.pet_id || '')) return null;
  if (!TYPE_RE.test(p.type || ''))   return null;
  if (!STAGE_RE.test(p.stage || 'baby')) return null;
  if (!NAME_RE.test(p.name || '')) return null;

  return {
    pet_id:          p.pet_id,
    wallet:          wallet,
    type:            p.type,
    name:            p.name,
    born_at:         asBigInt(p.born_at, 0, 9999999999999),
    last_fed_at:     asBigInt(p.last_fed_at, 0, 9999999999999),
    last_watered_at: asBigInt(p.last_watered_at, 0, 9999999999999),
    last_updated_at: Date.now(),
    hunger:          num(p.hunger, 0, 100) ?? 100,
    thirst:          num(p.thirst, 0, 100) ?? 100,
    happiness:       num(p.happiness, 0, 100) ?? 80,
    stage:           p.stage || 'baby',
    days_alive:      asInt(p.days_alive, 1, 30) ?? 1,
    total_burned:    asBigInt(p.total_burned, 0, Number.MAX_SAFE_INTEGER),
    feed_count:      asInt(p.feed_count, 0, 1000000) ?? 0,
    water_count:     asInt(p.water_count, 0, 1000000) ?? 0,
    hungry_events:   asInt(p.hungry_events, 0, 1000000) ?? 0,
    thirsty_events:  asInt(p.thirsty_events, 0, 1000000) ?? 0,
    cosmetics:       sanitizeCosmetics(p.cosmetics),
    owned_items:     sanitizeOwnedItems(p.owned_items),
    hatch_tx:        (typeof p.hatch_tx === 'string' && /^0x[a-fA-F0-9]{1,66}$/.test(p.hatch_tx)) ? p.hatch_tx : null,
    bonded:          !!p.bonded,
    bonded_at:       p.bonded_at ? new Date(p.bonded_at).toISOString() : null,
    bond_tx:         (typeof p.bond_tx === 'string' && /^0x[a-fA-F0-9]{1,66}$/.test(p.bond_tx)) ? p.bond_tx : null,
    died_at:         p.died_at ? new Date(p.died_at).toISOString() : null,
    death_cause:     ['starvation','thirst','sadness'].includes(p.death_cause) ? p.death_cause : null,
    revived_count:   asInt(p.revived_count, 0, 100) ?? 0,
    buried:          !!p.buried,
    critical_since:  asBigInt(p.critical_since, 0, 9999999999999) || null
  };
}

async function sb(path, opts){
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_KEY) return res.status(500).json({ error: 'storage not configured' });

  // ── GET ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const wallet = (req.query.wallet || '').toLowerCase();
    const petId  = req.query.pet_id || '';
    if (petId) {
      if (!UUID_RE.test(petId)) return res.status(400).json({ error: 'bad pet_id' });
      const r = await sb(`/rest/v1/chogi_pets?pet_id=eq.${encodeURIComponent(petId)}&select=*&limit=1`);
      const rows = await r.json();
      return res.status(200).json({ pets: rows || [] });
    }
    if (!WALLET_RE.test(wallet)) return res.status(400).json({ error: 'bad wallet' });
    const r = await sb(`/rest/v1/chogi_pets?wallet=eq.${encodeURIComponent(wallet)}&select=*&order=born_at.asc`);
    const rows = await r.json();
    return res.status(200).json({ pets: rows || [] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST or GET only' });

  // ── POST ───────────────────────────────────────────────────
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (e) { return res.status(400).json({ error: 'bad json' }); }

  let { wallet, pet, pet_id, bury } = body || {};
  if (typeof wallet !== 'string' || !WALLET_RE.test(wallet)) {
    return res.status(400).json({ error: 'bad wallet' });
  }
  wallet = wallet.toLowerCase();
  if (isBlocked(wallet)) {
    return res.status(403).json({ error: 'wallet blocked', code: 'FLAGGED' });
  }

  // bury action (single column update)
  if (bury === true) {
    if (!UUID_RE.test(pet_id || '')) return res.status(400).json({ error: 'bad pet_id' });
    const owner = await sb(`/rest/v1/chogi_pets?pet_id=eq.${encodeURIComponent(pet_id)}&select=wallet&limit=1`);
    const rows = await owner.json();
    if (!rows || !rows[0]) return res.status(404).json({ error: 'pet not found' });
    if (rows[0].wallet.toLowerCase() !== wallet) {
      return res.status(403).json({ error: 'not owner' });
    }
    const upd = await sb(`/rest/v1/chogi_pets?pet_id=eq.${encodeURIComponent(pet_id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ buried: true, last_updated_at: Date.now() })
    });
    return res.status(upd.ok ? 200 : 502).json({ ok: upd.ok });
  }

  // upsert flow
  const row = buildRow(wallet, pet);
  if (!row) return res.status(400).json({ error: 'invalid pet payload' });

  // if pet exists already, the wallet on file must match (anti-takeover)
  const existing = await sb(`/rest/v1/chogi_pets?pet_id=eq.${encodeURIComponent(row.pet_id)}&select=wallet,bonded,bond_tx&limit=1`);
  const exRows = await existing.json();
  if (exRows && exRows[0]) {
    if (exRows[0].wallet.toLowerCase() !== wallet) {
      return res.status(403).json({ error: 'not owner' });
    }
    // never let a client *unset* `bonded` once true (bond is supposed to be permanent),
    // and don't let a client toggle `bonded` on without a bond_tx already on record
    if (!row.bonded && exRows[0].bonded) row.bonded = true;
    if (row.bonded && !exRows[0].bonded && !row.bond_tx) {
      return res.status(400).json({ error: 'bond_tx required to bond' });
    }
  } else {
    // fresh pet — bonded must be false; clients shouldn't be able to backdoor a bond
    row.bonded   = false;
    row.bond_tx  = null;
    row.bonded_at = null;
  }

  const up = await sb('/rest/v1/chogi_pets', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
  if (!up.ok) {
    const text = await up.text();
    console.error('pet upsert failed', up.status, text);
    return res.status(502).json({ error: 'storage error' });
  }
  return res.status(200).json({ ok: true });
}
