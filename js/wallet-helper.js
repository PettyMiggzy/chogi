/* Wallet helper — detect Safari/Chrome on iOS where window.ethereum doesn't exist
   and show users a modal with deeplinks that open chogi.xyz inside their wallet's
   in-app browser. Without this people on iPhone can't connect. */
(function () {
  if (window.ChogiWallet) return; // already loaded

  function isMobile() {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  }
  function isIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
  function isInWalletBrowser() {
    return !!window.ethereum;
  }

  function path() {
    // current page path + query/hash, stripped of leading slash
    var p = window.location.pathname + window.location.search + window.location.hash;
    return p.replace(/^\/+/, '');
  }

  function deeplinks() {
    var host = 'chogi.xyz';
    var fullPath = path();
    var encoded = encodeURIComponent(host + (fullPath ? '/' + fullPath : ''));
    return {
      // MetaMask universal link works on iOS + Android
      metamask: 'https://metamask.app.link/dapp/' + host + (fullPath ? '/' + fullPath : ''),
      // Rabby has its own deeplink scheme
      rabby:    'https://rabby.io/dapp?url=' + encoded,
      // Phantom EVM deeplink
      phantom:  'https://phantom.app/ul/browse/' + encoded,
      // Trust wallet
      trust:    'https://link.trustwallet.com/open_url?coin_id=60&url=' + encoded,
    };
  }

  function injectStyles() {
    if (document.getElementById('chogi-wallet-style')) return;
    var s = document.createElement('style');
    s.id = 'chogi-wallet-style';
    s.textContent =
      '#chogi-wallet-modal{position:fixed;inset:0;z-index:99999;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);padding:0;}'+
      '#chogi-wallet-modal.show{display:flex;}'+
      '#chogi-wallet-sheet{width:100%;max-width:560px;background:linear-gradient(180deg,#1a0436,#0a0118);border:1.5px solid rgba(255,20,147,.5);border-bottom:0;border-radius:22px 22px 0 0;padding:22px 20px max(28px,env(safe-area-inset-bottom)) 20px;box-shadow:0 -16px 60px rgba(0,0,0,.6),0 0 36px rgba(255,20,147,.18);font-family:system-ui,sans-serif;color:#FFE9F4;animation:chogiSheetUp .28s cubic-bezier(.2,.9,.2,1);}'+
      '@keyframes chogiSheetUp{from{transform:translateY(100%);}to{transform:translateY(0);}}'+
      '#chogi-wallet-sheet .grip{width:42px;height:5px;border-radius:3px;background:rgba(255,255,255,.2);margin:0 auto 14px;}'+
      '#chogi-wallet-sheet h3{font-family:Bungee,system-ui,sans-serif;font-size:16px;letter-spacing:2px;color:#FF1493;text-align:center;margin-bottom:6px;}'+
      '#chogi-wallet-sheet .sub{font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:1px;color:rgba(255,233,244,.65);text-align:center;margin-bottom:18px;line-height:1.5;}'+
      '#chogi-wallet-sheet .opt{display:flex;align-items:center;gap:14px;width:100%;padding:14px 16px;margin-bottom:8px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;text-decoration:none;font-family:Bungee,sans-serif;font-size:13px;letter-spacing:1.5px;transition:all .15s;}'+
      '#chogi-wallet-sheet .opt:active{transform:scale(.98);}'+
      '#chogi-wallet-sheet .opt .ico{width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;}'+
      '#chogi-wallet-sheet .opt .ico.metamask{background:linear-gradient(135deg,#e8821e,#c66811);}'+
      '#chogi-wallet-sheet .opt .ico.rabby{background:linear-gradient(135deg,#7084ff,#3b4eb7);}'+
      '#chogi-wallet-sheet .opt .ico.phantom{background:linear-gradient(135deg,#ab9ff2,#534bb1);}'+
      '#chogi-wallet-sheet .opt .ico.trust{background:linear-gradient(135deg,#3375bb,#1c4a85);}'+
      '#chogi-wallet-sheet .opt .meta{flex:1;display:flex;flex-direction:column;gap:2px;}'+
      '#chogi-wallet-sheet .opt .meta small{font-family:JetBrains Mono,monospace;font-size:9px;letter-spacing:1px;color:rgba(255,233,244,.5);font-weight:400;letter-spacing:1px;}'+
      '#chogi-wallet-sheet .opt .arrow{font-size:18px;opacity:.4;}'+
      '#chogi-wallet-sheet .closebar{display:block;width:100%;margin-top:10px;padding:13px;background:rgba(255,255,255,.06);color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:11px;font-family:Bungee,sans-serif;font-size:11px;letter-spacing:2px;cursor:pointer;}'+
      '#chogi-wallet-sheet .hint{margin-top:14px;font-family:JetBrains Mono,monospace;font-size:9px;letter-spacing:1px;color:rgba(255,233,244,.4);text-align:center;line-height:1.6;}';
    document.head.appendChild(s);
  }

  function showSheet() {
    injectStyles();
    if (document.getElementById('chogi-wallet-modal')) {
      document.getElementById('chogi-wallet-modal').classList.add('show');
      return;
    }
    var d = deeplinks();
    var modal = document.createElement('div');
    modal.id = 'chogi-wallet-modal';
    modal.innerHTML =
      '<div id="chogi-wallet-sheet">' +
        '<div class="grip"></div>' +
        '<h3>🟣 OPEN IN A WALLET</h3>' +
        '<div class="sub">Safari can\'t talk to crypto wallets directly.<br>Tap your wallet — it opens chogi.xyz inside it.</div>' +
        '<a class="opt" href="' + d.metamask + '"><span class="ico metamask">🦊</span><span class="meta">MetaMask<small>most popular · evm wallets</small></span><span class="arrow">→</span></a>' +
        '<a class="opt" href="' + d.rabby    + '"><span class="ico rabby">🐰</span><span class="meta">Rabby<small>fastest evm wallet</small></span><span class="arrow">→</span></a>' +
        '<a class="opt" href="' + d.phantom  + '"><span class="ico phantom">👻</span><span class="meta">Phantom<small>solana + evm</small></span><span class="arrow">→</span></a>' +
        '<a class="opt" href="' + d.trust    + '"><span class="ico trust">🛡</span><span class="meta">Trust Wallet<small>multi-chain</small></span><span class="arrow">→</span></a>' +
        '<button class="closebar" type="button">CLOSE</button>' +
        '<div class="hint">don\'t have a wallet yet? install MetaMask or Rabby from the App Store, then come back and tap CONNECT.</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.classList.add('show');
    modal.querySelector('.closebar').addEventListener('click', hideSheet);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) hideSheet();
    });
  }
  function hideSheet() {
    var m = document.getElementById('chogi-wallet-modal');
    if (m) m.classList.remove('show');
  }

  /**
   * Public API:
   *   ChogiWallet.requireWallet()  → returns true if window.ethereum exists,
   *     otherwise shows the deeplink sheet and returns false. Use BEFORE
   *     calling any wallet method.
   */
  window.ChogiWallet = {
    requireWallet: function () {
      if (isInWalletBrowser()) return true;
      if (isMobile()) {
        showSheet();
      } else {
        alert('No wallet detected.\nInstall MetaMask or Rabby browser extension and refresh.');
      }
      return false;
    },
    showSheet: showSheet,
    hideSheet: hideSheet,
    isInWalletBrowser: isInWalletBrowser,
    isMobile: isMobile,
    isIOS: isIOS,
  };
})();
