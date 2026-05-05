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
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1cWhxY21yZ3BkamxoeXF6dG5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMjQ4NDAsImV4cCI6MjA5MjgwMDg0MH0.bsmuC_onaPutZmYZWTn9p1DvngKIA7Xx4J3YRajbf-8'
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
