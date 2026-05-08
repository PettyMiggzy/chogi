/* Chogi site config — public values only (anon key is safe to expose).
   To enable cloud-synced pets:
   1. Open Supabase project → Settings → API
   2. Copy the "anon / public" key (starts with eyJ...)
   3. Paste into ANON_KEY below
   4. Run the SQL in /supabase/schema.sql in your Supabase SQL editor
   5. Deploy

   If ANON_KEY is empty, the site falls back to localStorage-only (offline).
*/
(function(){
  window.ChogiConfig = {
    SUPABASE_URL: 'https://cuqhqcmrgpdjlhyqztnc.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1cWhxY21yZ3BkamxoeXF6dG5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMjQ4NDAsImV4cCI6MjA5MjgwMDg0MH0.bsmuC_onaPutZmYZWTn9p1DvngKIA7Xx4J3YRajbf-8',

    // ─── on-chain ────────────────────────────────────────────────
    CHAIN_HEX:   '0x8f',
    RPC:         '',
    EXPLORER:    'https://monadexplorer.com',
    TOKEN:       '0x5E1b1A14c8758104B8560514e94ab8320e587777',
    DEAD:        '0x000000000000000000000000000000000000dEaD',

    // Deployed 2026-05-08 on Monad mainnet:
    PAYROLL_ADDRESS:     '0x062E18beceF54077E6325B415aB74522d64D3af7',
    SWAP_BURNER_ADDRESS: '0x9Db6552ab771d57E108c77371c128FCc466291e9',
    NFT_ADDRESS:         '0xe753780772c1EAA676accA32e6030B346faF1C0F'
  };

  // auto-init pet store if helper is loaded
  if(window.ChogiPetStore){
    window.ChogiPetStore.init(window.ChogiConfig.SUPABASE_URL, window.ChogiConfig.SUPABASE_ANON_KEY);
  } else {
    // wait for the script to load
    document.addEventListener('DOMContentLoaded', function(){
      if(window.ChogiPetStore){
        window.ChogiPetStore.init(window.ChogiConfig.SUPABASE_URL, window.ChogiConfig.SUPABASE_ANON_KEY);
      }
    });
  }
})();
