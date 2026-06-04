/* Chogi Connect Pill
   ────────────────────────────────────────────
   Floating bottom-right wallet button that works on every page.
   - Shows "CONNECT WALLET" when disconnected
   - Shows "0xABC…123 · 1.2K $CHOGI" pill when connected
   - Click while connected to copy address / disconnect
   - Auto-switches to Monad mainnet on connect
   - Fires `chogi:connected` and `chogi:disconnected` events the host
     page can listen to; also exposes window.ChogiConnect for direct calls.
*/
(function(){
  if(window.ChogiConnect) return;

  var TOKEN  = '0x5E1b1A14c8758104B8560514e94ab8320e587777';
  var RPC    = '/api/rpc';
  var CHAIN  = '0x8f';   // 143

  var account = null;

  function $(id){ return document.getElementById(id); }
  function pad32(hex){ return hex.toLowerCase().replace('0x','').padStart(64,'0'); }
  function fmtBal(weiBig){
    var n = Number(weiBig) / 1e18;
    if(n >= 1e9) return (n/1e9).toFixed(2)+'B';
    if(n >= 1e6) return (n/1e6).toFixed(2)+'M';
    if(n >= 1e3) return (n/1e3).toFixed(1)+'K';
    return n.toFixed(0);
  }

  /* ─── styles ─── */
  function injectStyles(){
    if(document.getElementById('chogi-connect-styles')) return;
    var css = `
.chogi-connect-pill{
  position:fixed; bottom:18px; right:18px; z-index:9999;
  display:flex; align-items:center; gap:8px;
  padding:11px 18px; border-radius:99px;
  background:linear-gradient(135deg,#FF1493,#A855F7);
  color:#fff; font-family:'JetBrains Mono','Courier New',monospace;
  font-size:11px; font-weight:700; letter-spacing:.13em; text-transform:uppercase;
  border:none; cursor:pointer; user-select:none;
  box-shadow:0 6px 24px rgba(255,20,147,.35), 0 0 0 1px rgba(255,255,255,.08) inset;
  transition:transform .15s ease, box-shadow .15s ease;
}
.chogi-connect-pill:hover{
  transform:translateY(-2px);
  box-shadow:0 10px 30px rgba(255,20,147,.5), 0 0 0 1px rgba(255,255,255,.12) inset;
}
.chogi-connect-pill.connected{
  background:rgba(20,16,40,.92);
  border:1px solid rgba(255,20,147,.4);
  backdrop-filter:blur(10px);
}
.chogi-connect-pill .dot{
  width:8px; height:8px; border-radius:50%;
  background:#FF1493; box-shadow:0 0 10px #FF1493;
}
.chogi-connect-pill.connected .dot{
  background:#00ff88; box-shadow:0 0 10px #00ff88;
}
.chogi-connect-menu{
  position:fixed; bottom:62px; right:18px; z-index:9999;
  background:rgba(20,16,40,.96); backdrop-filter:blur(12px);
  border:1px solid rgba(255,20,147,.3); border-radius:14px;
  padding:6px; min-width:200px;
  box-shadow:0 12px 40px rgba(0,0,0,.5);
  display:none;
}
.chogi-connect-menu.show{display:block}
.chogi-connect-menu button{
  display:block; width:100%; padding:10px 14px; text-align:left;
  background:transparent; border:none; color:#fff5e6;
  font-family:'JetBrains Mono',monospace; font-size:11px;
  letter-spacing:.13em; text-transform:uppercase; font-weight:600;
  cursor:pointer; border-radius:9px; transition:background .15s;
}
.chogi-connect-menu button:hover{
  background:rgba(255,20,147,.12);
}
.chogi-connect-menu .danger{ color:#ff6b8a }
@media (max-width:520px){
  .chogi-connect-pill{ bottom:14px; right:14px; padding:10px 14px; font-size:10px }
  .chogi-connect-menu{ bottom:58px; right:14px }
}
`;
    var s = document.createElement('style');
    s.id = 'chogi-connect-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ─── DOM ─── */
  function ensureDom(){
    injectStyles();
    if($('chogiConnectPill')) return;
    var btn = document.createElement('button');
    btn.id = 'chogiConnectPill';
    btn.className = 'chogi-connect-pill';
    btn.type = 'button';
    btn.innerHTML = '<span class="dot"></span><span id="chogiConnectLabel">CONNECT WALLET</span>';
    btn.addEventListener('click', onPillClick);
    document.body.appendChild(btn);

    var menu = document.createElement('div');
    menu.id = 'chogiConnectMenu';
    menu.className = 'chogi-connect-menu';
    menu.innerHTML = '<button id="chogiCopyAddr">📋 COPY ADDRESS</button>'
                   + '<button id="chogiViewExplorer">🔎 VIEW ON EXPLORER</button>'
                   + '<button id="chogiDisconnect" class="danger">⏏ DISCONNECT</button>';
    document.body.appendChild(menu);

    $('chogiCopyAddr').addEventListener('click', function(){
      if(!account) return;
      try{
        navigator.clipboard.writeText(account);
        $('chogiCopyAddr').textContent = '✓ COPIED';
        setTimeout(function(){ $('chogiCopyAddr').textContent = '📋 COPY ADDRESS'; }, 1400);
      }catch(e){}
    });
    $('chogiViewExplorer').addEventListener('click', function(){
      if(!account) return;
      window.open('https://monadexplorer.com/address/' + account, '_blank');
      hideMenu();
    });
    $('chogiDisconnect').addEventListener('click', function(){
      account = null;
      try { localStorage.removeItem('chogi_last_wallet'); } catch(e){}
      hideMenu();
      render();
      window.dispatchEvent(new CustomEvent('chogi:disconnected'));
    });

    document.addEventListener('click', function(e){
      var menu = $('chogiConnectMenu');
      var pill = $('chogiConnectPill');
      if(menu && menu.classList.contains('show')
         && !menu.contains(e.target) && e.target !== pill && !pill.contains(e.target)){
        hideMenu();
      }
    });
  }

  function showMenu(){ $('chogiConnectMenu').classList.add('show'); }
  function hideMenu(){ $('chogiConnectMenu').classList.remove('show'); }

  /* ─── render ─── */
  function render(){
    ensureDom();
    var pill = $('chogiConnectPill');
    var label = $('chogiConnectLabel');
    if(account){
      pill.classList.add('connected');
      var short = account.slice(0,6) + '…' + account.slice(-4);
      label.textContent = short;
      // try to fetch balance and append
      rpcCall('0x70a08231' + pad32(account)).then(function(bal){
        if(account) label.innerHTML = short + ' <span style="opacity:.6">·</span> ' + fmtBal(bal) + ' $CHOGI';
      }).catch(function(){});
    } else {
      pill.classList.remove('connected');
      label.textContent = 'CONNECT WALLET';
    }
  }

  /* ─── click handler ─── */
  function onPillClick(){
    if(account){
      var menu = $('chogiConnectMenu');
      if(menu.classList.contains('show')) hideMenu();
      else showMenu();
    } else {
      connect();
    }
  }

  /* ─── core connect ─── */
  async function connect(){
    if(!window.ethereum){
      // mobile fallback
      if(window.ChogiWallet && window.ChogiWallet.requireWallet){
        window.ChogiWallet.requireWallet();
      } else {
        alert('Install MetaMask, Rabby, or Phantom to connect.');
      }
      return false;
    }
    try{
      var accs = await window.ethereum.request({ method:'eth_requestAccounts' });
      if(!accs || !accs[0]) return false;
      account = accs[0];

      // ensure Monad chain
      try{
        await window.ethereum.request({ method:'wallet_switchEthereumChain', params:[{chainId:CHAIN}] });
      }catch(e){
        if(e.code === 4902){
          await window.ethereum.request({
            method:'wallet_addEthereumChain',
            params:[{
              chainId:CHAIN, chainName:'Monad',
              nativeCurrency:{name:'MON',symbol:'MON',decimals:18},
              rpcUrls:['https://rpc.monad.xyz'], blockExplorerUrls:['https://monadexplorer.com']
            }]
          });
        } else throw e;
      }

      try { localStorage.setItem('chogi_last_wallet', account); } catch(e){}
      render();
      window.dispatchEvent(new CustomEvent('chogi:connected', { detail:{ account: account } }));
      return true;
    }catch(e){
      console.warn('[ChogiConnect] connect failed:', e.message);
      return false;
    }
  }

  /* ─── RPC ─── */
  async function rpcCall(data){
    var r = await fetch(RPC, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0', method:'eth_call', params:[{to:TOKEN, data:data}, 'latest'], id:1})
    });
    var j = await r.json();
    return BigInt(j.result || '0x0');
  }

  /* ─── auto-init ─── */
  function init(){
    ensureDom();
    // NO auto-connect — wallet only touched on explicit CONNECT click.
    render();
    // listen to changes
    if(window.ethereum && window.ethereum.on){
      window.ethereum.on('accountsChanged', function(accs){
        account = (accs && accs[0]) || null;
        render();
        if(account){
          window.dispatchEvent(new CustomEvent('chogi:connected', { detail:{ account: account } }));
        } else {
          window.dispatchEvent(new CustomEvent('chogi:disconnected'));
        }
      });
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ─── public API ─── */
  window.ChogiConnect = {
    connect: connect,
    disconnect: function(){
      account = null;
      render();
      window.dispatchEvent(new CustomEvent('chogi:disconnected'));
    },
    getAccount: function(){ return account; },
    isConnected: function(){ return !!account; }
  };
})();
