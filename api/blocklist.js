// /api/blocklist.js
// Server-side blocklist module + single source of truth for the public registry.
// Imported by other API handlers (/api/pin.js, /api/inspect.js, etc) to reject
// blocked wallets before they hit Supabase or other gated systems.
//
// Also surfaced publicly via /api/blocked-list (returns BLOCKED_LIST as JSON)
// for the /banned page to render the containment registry.
//
// To add a new banned wallet:
//   1. Add an entry to BLOCKED_LIST below (lowercase address)
//   2. Mirror the address in /js/blocklist.js (client-side redirect)
//   3. Commit + push. Live in 30s.

const BLOCKED_LIST = [
  {
    addr:      '0x9e83af29ac55bee937fbec87da0030f4fd4bc166',
    label:     'KILLA',
    reason:    'Buy/dump cycler · damages floor',
    flaggedAt: '2026-04-28'
  },
  {
    addr:      '0xca4595193c26450a50f492003572ae96ac9dd316',
    label:     'KILLA-2',
    reason:    'Associated wallet',
    flaggedAt: '2026-04-28'
  },
  {
    addr:      '0xabd53a08a01e4838c71a3b3ff6266a49a4f028e1',
    label:     'KILLA-3',
    reason:    'Associated wallet',
    flaggedAt: '2026-04-28'
  },
  {
    addr:      '0x870634b470a7c87fd2824d88d8670839b860bee3',
    label:     'KILLA-4',
    reason:    'Associated wallet',
    flaggedAt: '2026-04-28'
  },
  {
    addr:      '0x63fc704d559023a2ddb04717f6997cc98445626a',
    label:     'FLAGGED',
    reason:    'Flagged by admin',
    flaggedAt: '2026-05-10'
  }
];

const BLOCKED = new Set(BLOCKED_LIST.map(w => w.addr.toLowerCase()));

export function isBlocked(addr){
  if(!addr || typeof addr !== 'string') return false;
  return BLOCKED.has(addr.toLowerCase());
}

// Public registry — used by /api/blocked-list and the /banned page renderer.
// Returns a fresh array (so callers can't mutate the source).
export function getPublicList(){
  return BLOCKED_LIST.map(w => ({
    addr:      w.addr,
    label:     w.label,
    reason:    w.reason,
    flaggedAt: w.flaggedAt
  }));
}

export default { isBlocked, getPublicList };
