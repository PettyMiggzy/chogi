// /api/blocklist.js
// Server-side blocklist module. Mirrors /js/blocklist.js.
// Imported by other API handlers (/api/pin.js etc) to reject blocked wallets
// before they hit Supabase.

const BLOCKED = new Set([
  '0x9e83af29ac55bee937fbec87da0030f4fd4bc166', // KILLA
  '0xca4595193c26450a50f492003572ae96ac9dd316', // associated
  '0xabd53a08a01e4838c71a3b3ff6266a49a4f028e1', // associated
  '0x870634b470a7c87fd2824d88d8670839b860bee3'  // associated
]);

export function isBlocked(addr){
  if(!addr || typeof addr !== 'string') return false;
  return BLOCKED.has(addr.toLowerCase());
}

// Default export so handler imports work either way
export default { isBlocked };
