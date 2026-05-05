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
    SUPABASE_ANON_KEY: '' // ← paste anon key here
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
