// /js/blocklist.js
// Central wallet + device blocklist for $CHOGI. Single source of truth.
// Any page that loads this script automatically:
//   1. Computes the visitor's device fingerprint
//   2. If fingerprint is in BLOCKED_DEVICES → immediate redirect to /banned
//   3. Listens for chogi:connected events
//   4. If connected wallet is in BLOCKED_WALLETS → captures IP + fingerprint
//      then redirects to /banned
//   5. Provides window.ChogiBlocklist.* helpers for any other code
//
// Server-side enforcement is in /api/blocklist.js (mirrors wallet list).
// Captured IPs + fingerprints land in Supabase chogi_blocked_attempts.

(function(){
  // ─── BLOCKED WALLETS (lowercase) ────────────────────────────────────────
  var BLOCKED = [
    '0x9e83af29ac55bee937fbec87da0030f4fd4bc166', // KILLA — buy/dump cycler
    '0xca4595193c26450a50f492003572ae96ac9dd316', // associated wallet
    '0xabd53a08a01e4838c71a3b3ff6266a49a4f028e1', // associated wallet
    '0x870634b470a7c87fd2824d88d8670839b860bee3', // associated wallet
    '0x63fc704d559023a2ddb04717f6997cc98445626a'  // flagged 2026-05-10
  ];

  // ─── BLOCKED DEVICE FINGERPRINTS ────────────────────────────────────────
  // After captures appear in chogi_blocked_attempts.fingerprint column,
  // copy fingerprints here, push, and they're hard-blocked across the site.
  var BLOCKED_DEVICES = [
    // 'a1b2c3d4e5f6...',
  ];

  function norm(addr){ return (addr || '').toLowerCase(); }
  function isBlocked(addr){ return !!addr && BLOCKED.indexOf(norm(addr)) !== -1; }
  function isBlockedDevice(fp){ return !!fp && BLOCKED_DEVICES.indexOf(fp) !== -1; }

  // ─── DEVICE FINGERPRINT ─────────────────────────────────────────────────
  // Synchronous lightweight fingerprint. Combines stable browser/device
  // signals into a djb2 hash. Not as robust as FingerprintJS Pro, but
  // fine for spotting the same device across reconnects.
  function getDeviceFingerprint(){
    try {
      var parts = [];
      parts.push(navigator.userAgent || '');
      parts.push(navigator.language || '');
      parts.push((navigator.languages || []).join(','));
      parts.push(screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || 0));
      parts.push(window.devicePixelRatio || 1);
      parts.push(new Date().getTimezoneOffset());
      parts.push(navigator.hardwareConcurrency || 0);
      parts.push(navigator.maxTouchPoints || 0);
      parts.push(navigator.platform || '');
      parts.push((navigator.deviceMemory || '') + '');

      // Canvas fingerprint (the workhorse — produces device-unique pixel data
      // due to font rendering / GPU / driver differences)
      try {
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        canvas.width = 240; canvas.height = 60;
        ctx.textBaseline = 'top';
        ctx.font = "14px 'Arial'";
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 100, 100);
        ctx.fillStyle = '#069';
        ctx.fillText('CHOGI 7777 \u2615', 2, 15);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fillText('CHOGI 7777 \u2615', 4, 17);
        ctx.beginPath();
        ctx.arc(50, 30, 20, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.fillStyle = 'rgb(255,0,255)';
        ctx.fill();
        parts.push(canvas.toDataURL());
      } catch(e){}

      // WebGL renderer string (also varies per GPU/driver)
      try {
        var gl = document.createElement('canvas').getContext('webgl');
        if(gl){
          var debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if(debugInfo){
            parts.push(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL));
            parts.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
          }
        }
      } catch(e){}

      // djb2 hash → base36, 64-bit equivalent space
      var s = parts.join('|');
      var h1 = 5381, h2 = 52711;
      for(var i = 0; i < s.length; i++){
        var c = s.charCodeAt(i);
        h1 = ((h1 << 5) + h1) + c;
        h2 = ((h2 << 5) - h2) + c;
        h1 = h1 & 0x7fffffff;
        h2 = h2 & 0x7fffffff;
      }
      return h1.toString(36) + h2.toString(36);
    } catch(e){
      return 'fp-error';
    }
  }

  var deviceFp = getDeviceFingerprint();

  // expose globally
  window.ChogiBlocklist = {
    isBlocked: isBlocked,
    isBlockedDevice: isBlockedDevice,
    fingerprint: deviceFp,
    list: function(){ return BLOCKED.slice(); },
    devices: function(){ return BLOCKED_DEVICES.slice(); }
  };

  // ─── DEVICE BLOCK CHECK (runs immediately on script load) ───────────────
  if(isBlockedDevice(deviceFp) && location.pathname !== '/banned' && location.pathname !== '/banned.html'){
    // Capture-and-redirect even without wallet (device alone is enough)
    try {
      sessionStorage.setItem('chogi_banned_reason', 'device');
    } catch(e){}
    fetch('/api/log-blocked-attempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: '0x0000000000000000000000000000000000000000', fingerprint: deviceFp, reason: 'device-match' }),
      keepalive: true
    }).catch(function(){});
    setTimeout(function(){ location.href = '/banned'; }, 200);
    return;
  }

  // ─── Auto-handle connection: if blocked wallet connects, redirect ───────
  function handleBlockedConnect(addr){
    if(location.pathname === '/banned' || location.pathname === '/banned.html') return;

    // Capture wallet + IP + fingerprint server-side (fire-and-forget)
    try {
      fetch('/api/log-blocked-attempt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: addr, fingerprint: deviceFp }),
        keepalive: true
      }).catch(function(){});
    } catch(e){}

    try { sessionStorage.setItem('chogi_banned_wallet', addr); } catch(e){}
    try {
      if(window.ChogiConnect && typeof window.ChogiConnect.disconnect === 'function'){
        window.ChogiConnect.disconnect();
      }
    } catch(e){}

    setTimeout(function(){ location.href = '/banned'; }, 250);
  }

  window.addEventListener('chogi:connected', function(e){
    var addr = e && e.detail && e.detail.account;
    if(addr && isBlocked(addr)){
      handleBlockedConnect(addr);
    }
  });

  // Also check on script load in case a wallet was already connected
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
