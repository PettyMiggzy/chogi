// /js/blocklist.js
// Central wallet blocklist for $CHOGI. Single source of truth.
// Any page that loads this script automatically:
//   1. Listens for chogi:connected events
//   2. If the connected wallet is blocked → redirects to /banned
//   3. Provides window.ChogiBlocklist.isBlocked(addr) for any other code that needs to check
//
// Server-side enforcement is in /api/blocklist.js (mirrors this list).
// To unblock a wallet: remove from this array AND from /api/blocklist.js, push.

(function(){
  // Blocked wallets (always lowercase, no checksum case).
  var BLOCKED = [
    '0x9e83af29ac55bee937fbec87da0030f4fd4bc166'  // FUD_MASTER KILLA — buy/dump cycler tanking the chart
  ];

  function norm(addr){ return (addr || '').toLowerCase(); }

  function isBlocked(addr){
    if(!addr) return false;
    return BLOCKED.indexOf(norm(addr)) !== -1;
  }

  // expose globally
  window.ChogiBlocklist = {
    isBlocked: isBlocked,
    list: function(){ return BLOCKED.slice(); }
  };

  // ─── Auto-handle connection: if blocked wallet connects, redirect ───────
  function handleBlockedConnect(addr){
    // Don't redirect if we're already on the banned page
    if(location.pathname === '/banned' || location.pathname === '/banned.html') return;

    // ── CAPTURE IP via server (fire-and-forget) ────────────────────────
    // Server logs to chogi_blocked_attempts table. Doesn't matter if the
    // call fails — we still redirect either way.
    try {
      fetch('/api/log-blocked-attempt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: addr }),
        keepalive: true   // ensures the call goes out even if we redirect immediately
      }).catch(function(){});
    } catch(e){}

    // Save the offending wallet so /banned can show it
    try { sessionStorage.setItem('chogi_banned_wallet', addr); } catch(e){}

    // Disconnect any wallet helper state
    try {
      if(window.ChogiConnect && typeof window.ChogiConnect.disconnect === 'function'){
        window.ChogiConnect.disconnect();
      }
    } catch(e){}

    // Redirect after a short delay so the IP capture call gets out
    setTimeout(function(){ location.href = '/banned'; }, 250);
  }

  window.addEventListener('chogi:connected', function(e){
    var addr = e && e.detail && e.detail.account;
    if(addr && isBlocked(addr)){
      handleBlockedConnect(addr);
    }
  });

  // Also check on script load in case a wallet was already connected before this loaded
  setTimeout(function(){
    try {
      if(window.ChogiConnect && window.ChogiConnect.isConnected && window.ChogiConnect.isConnected()){
        var existing = window.ChogiConnect.getAccount && window.ChogiConnect.getAccount();
        if(existing && isBlocked(existing)){
          handleBlockedConnect(existing);
        }
      }
    } catch(e){}
  }, 600);
})();
