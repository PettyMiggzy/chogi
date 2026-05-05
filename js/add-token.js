/* Add-token-to-wallet helper using EIP-747 (wallet_watchAsset).
   Renders a button anywhere a placeholder element with id="add-chogi-btn" exists.
   Usage:  <button id="add-chogi-btn"></button>  → script auto-fills + wires it.
   Or call ChogiAddToken.add() directly from any element's click handler.
*/
(function(){
  if(window.ChogiAddToken) return;

  var TOKEN   = '0x5E1b1A14c8758104B8560514e94ab8320e587777';
  var SYMBOL  = 'CHOGI';
  var DECIMALS = 18;
  var IMAGE   = 'https://chogi.xyz/chogi.png';

  /* tiny toast */
  function toast(msg, kind){
    var t = document.getElementById('chogi-add-toast');
    if(!t){
      t = document.createElement('div');
      t.id = 'chogi-add-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(120px);z-index:99998;background:linear-gradient(135deg,#FF1493,#A855F7);color:#fff;padding:14px 22px;border-radius:99px;font-family:Bungee,system-ui,sans-serif;font-size:11px;letter-spacing:1.4px;box-shadow:0 14px 30px rgba(0,0,0,.4),0 0 26px rgba(255,20,147,.25);transition:.4s cubic-bezier(.2,.9,.3,1);max-width:90%;text-align:center;pointer-events:none';
      document.body.appendChild(t);
    }
    if(kind === 'err') t.style.background = 'linear-gradient(135deg,#ff6b8a,#A855F7)';
    else t.style.background = 'linear-gradient(135deg,#FF1493,#A855F7)';
    t.textContent = msg;
    t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(t._to);
    t._to = setTimeout(function(){
      t.style.transform = 'translateX(-50%) translateY(120px)';
    }, 3200);
  }

  async function add(){
    if(!window.ethereum){
      // mobile fallback — open in wallet browser
      if(window.ChogiWallet){ ChogiWallet.requireWallet(); return; }
      toast('NO WALLET DETECTED', 'err');
      return;
    }

    // ensure on Monad (wallet_watchAsset works without chain check, but cleaner UX if right chain)
    try{
      var chain = await window.ethereum.request({method:'eth_chainId'});
      if(chain !== '0x8f'){
        try{
          await window.ethereum.request({
            method:'wallet_switchEthereumChain',
            params:[{chainId:'0x8f'}]
          });
        }catch(e){
          if(e.code === 4902){
            await window.ethereum.request({
              method:'wallet_addEthereumChain',
              params:[{
                chainId:'0x8f',
                chainName:'Monad',
                nativeCurrency:{name:'MON',symbol:'MON',decimals:18},
                rpcUrls:['https://rpc.monad.xyz'],
                blockExplorerUrls:['https://monadexplorer.com']
              }]
            });
          }
          // else continue — some wallets don't support switch but support watchAsset
        }
      }
    }catch(e){
      console.warn('chain check failed, continuing:', e);
    }

    // request to add the token
    try{
      var ok = await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: TOKEN,
            symbol: SYMBOL,
            decimals: DECIMALS,
            image: IMAGE
          }
        }
      });
      if(ok){
        toast('✓ $CHOGI ADDED TO WALLET');
      } else {
        toast('CANCELLED');
      }
    }catch(e){
      console.error('watchAsset failed:', e);
      // fallback: copy contract to clipboard
      try{
        await navigator.clipboard.writeText(TOKEN);
        toast('CA COPIED · ADD MANUALLY', 'err');
      }catch(_){
        toast('FAILED — CA: '+TOKEN.slice(0,10)+'…', 'err');
      }
    }
  }

  /* auto-wire any element with class .add-chogi or id #add-chogi-btn */
  function wireUp(){
    var els = document.querySelectorAll('.add-chogi, #add-chogi-btn');
    els.forEach(function(el){
      if(el._chogiWired) return;
      el._chogiWired = true;
      // if it's empty, fill with default content
      if(!el.innerHTML.trim()){
        el.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>ADD $CHOGI TO WALLET</span>';
      }
      el.addEventListener('click', function(e){
        e.preventDefault();
        add();
      });
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wireUp);
  } else {
    wireUp();
  }

  // also expose globally
  window.ChogiAddToken = { add: add, wire: wireUp };
})();
