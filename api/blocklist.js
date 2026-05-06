// /api/blocklist.js
// Server-side blocklist module. Mirrors /js/blocklist.js.
// Imported by other API handlers (/api/pin.js etc) to reject blocked wallets
// before they hit Supabase.

const BLOCKED = new Set([
  '0x9e83af29ac55bee937fbec87da0030f4fd4bc166'  // FUD_MASTER KILLA
]);

export function isBlocked(addr){
  if(!addr || typeof addr !== 'string') return false;
  return BLOCKED.has(addr.toLowerCase());
}

// Default export so handler imports work either way
export default { isBlocked };
